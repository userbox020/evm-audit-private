#!/usr/bin/env node
// reverse-selectors.js — brute-force unknown 4-byte selectors against a signature
// dictionary derived from the pinned checkout sources. Offline.
"use strict";
const fs = require("fs"), path = require("path");
const { id } = require("./node_modules/ethers");
const ROOT = path.resolve(__dirname, "..");
const UNKNOWN = ["0x339ac427", "0x55448bc2", "0xb6934805"];

function walk(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules" && e.name !== ".git") walk(f, acc); }
    else if (e.name.endsWith(".sol")) acc.push(f);
  }
  return acc;
}
const files = walk(path.join(ROOT, "targets/across-contracts"), []);
const names = new Set();
const sigs = new Set();
const fnRe = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;
for (const f of files) {
  const txt = fs.readFileSync(f, "utf8");
  let m;
  while ((m = fnRe.exec(txt)) !== null) {
    names.add(m[1]);
    const params = m[2].split(",").map(s => s.trim()).filter(Boolean)
      .map(s => s.replace(/\b(calldata|memory|storage|indexed)\b/g, "").trim())
      .map(s => s.split(/\s+/)[0]).join(",");
    sigs.add(`${m[1]}(${params})`);
  }
}
// also derive plain names for combinations
const argSets = ["", "address", "bool", "uint256", "bytes", "bytes32", "uint32", "uint16", "address,address", "address,uint256", "uint256,uint256", "bytes,bytes", "address,bool", "uint32,address"];
const candidates = new Set(sigs);
for (const n of names) for (const a of argSets) candidates.add(`${n}(${a})`);

const hits = {};
for (const sig of candidates) {
  const sel = id(sig).slice(0, 10).toLowerCase();
  if (UNKNOWN.includes(sel)) { (hits[sel] = hits[sel] || []).push(sig); }
}
console.log("source .sol files:", files.length, "unique parsed sigs:", sigs.size, "candidates:", candidates.size);
for (const s of UNKNOWN) console.log(s, "->", hits[s] ? hits[s].slice(0, 8).join(" | ") : "NO_MATCH");
