#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname);

function sha(data) { return crypto.createHash("sha256").update(data).digest("hex"); }

function buildBinding() {
  // Load the same top-level runtime used by the capture runners.
  const ethers = require("ethers");
  void ethers.Interface;
  void ethers.Transaction;
  void ethers.AbiCoder;
  const rows = Object.keys(require.cache)
    .filter((file) => file.startsWith(path.join(ROOT, "node_modules") + path.sep))
    .map((file) => {
      const data = fs.readFileSync(file);
      return { relativePath: path.relative(ROOT, file).replaceAll("\\", "/"), bytes: data.length, sha256: sha(data) };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const packageLock = fs.readFileSync(path.join(ROOT, "package-lock.json"));
  return {
    schema: "termmax-v2-ethers-runtime-binding/v1",
    node: process.version,
    ethers: ethers.version,
    loadedFileCount: rows.length,
    loadedTotalBytes: rows.reduce((n, row) => n + row.bytes, 0),
    loadedFilesAggregateSha256: sha(Buffer.from(JSON.stringify(rows))),
    packageLockSha256: sha(packageLock),
  };
}

module.exports = { buildBinding };

if (require.main === module) console.log(JSON.stringify(buildBinding(), null, 2));
