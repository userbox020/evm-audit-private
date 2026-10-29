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

function zero(hex, ranges) {
  const b = Buffer.from(hex, "hex");
  for (const [s, l] of ranges) for (let i = s; i < s + l && i < b.length; i++) b[i] = 0;
  return b;
}

async function main() {
  const ep = await sharedRpc.resolveRpc(1, null, { capability: "read" });
  const res = await fetch(ep, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: ["0x44058C32B154A516F3b9DE2413e6cb938F93c3B4", "latest"] }),
  });
  const live = (await res.json()).result.replace(/^0x/, "");
  const art = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "targets", "term-finance-contracts-v2.1.2", "artifacts",
      "contracts", "factory", "TermRepoDeployerFactory.sol", "TermRepoDeployerFactory.json"), "utf8"))
    .deployedBytecode.replace(/^0x/, "");

  const zl = zero(live, RANGES), za = zero(art, RANGES);
  const n = parseInt(live.slice(-4), 16);
  const liveTail = live.slice(live.length - (n * 2 + 4));
  const artTail = art.slice(art.length - (n * 2 + 4));
  console.log(JSON.stringify({
    zeroedEqual: Buffer.compare(zl, za) === 0,
    zeroedKeccakLive: ethers.keccak256(zl),
    zeroedKeccakArtifact: ethers.keccak256(za),
    fixtureImmutableNormalized: "0x85533fd16302e835cdaa807bd12ed7fb45b7bdb1faac8009acf689de5d0bf72a",
    metadataTailEqual: liveTail === artTail,
    cborLen: n,
    liveTailBytes: liveTail.length / 2,
  }, null, 2));

  fs.writeFileSync(path.join(__dirname, "..", "reports", "raw", "termdiag-step1-identity-check.json"),
    JSON.stringify({
      schema: "termdiag-step1-identity-check/v1",
      generatedUtc: new Date().toISOString(),
      factory: {
        zeroedEqual: Buffer.compare(zl, za) === 0,
        zeroedKeccakLive: ethers.keccak256(zl),
        zeroedKeccakArtifact: ethers.keccak256(za),
        metadataTailEqual: liveTail === artTail,
        cborLen: n,
        liveTailBytes: liveTail.length / 2,
        liveTailSample: liveTail.slice(-120),
        artifactTailSample: artTail.slice(-120),
      },
    }, null, 2) + "\n");
}

main().catch((e) => { console.error("FATAL " + String(e.message || e).slice(0, 200)); process.exit(1); });
