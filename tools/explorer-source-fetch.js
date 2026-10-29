#!/usr/bin/env node
"use strict";
// explorer-source-fetch.js — read-only verified-source retrieval for defensive review.
// Retrieval order: Sourcify v2 (keyless) -> Etherscan v2 (key, process-only)
// -> Blockscout v2 (keyless). Never prints, logs, or persists credential material.
//
// Key handling is lazy and provider-gated:
// - The Etherscan key is only resolved when the Etherscan provider is actually
//   selected. Keyless providers (Sourcify/Blockscout) never read a `.env*` file.
// - `process.env.ETHERSCAN_API_KEY` is preferred when present.
// - A workspace `.env` file is read ONLY when the caller explicitly opts in with
//   `--allow-env-file` AND Etherscan is selected. No other code path reads `.env*`.
// - An Etherscan-only request without a key fails gracefully with a clear code.
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const ROOT = path.resolve(__dirname, "..");
const OUT_ROOT = path.join(ROOT, "reports", "raw", "fast", "explorer-source-review");
const USAGE = "usage: node tools/explorer-source-fetch.js --chain <id> --address <0x..> [--name <slug>] [--provider <sourcify|etherscan|blockscout>] [--allow-env-file]";

const BLOCKSCOUT_HOSTS = {
  "1": "eth.blockscout.com",
  "10": "optimism.blockscout.com",
  "56": "bsc.blockscout.com",
  "137": "polygon.blockscout.com",
  "8453": "base.blockscout.com",
  "42161": "arbitrum.blockscout.com",
};

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--chain") a.chain = argv[++i];
    else if (k === "--address") a.address = argv[++i];
    else if (k === "--name") a.name = argv[++i];
    else if (k === "--provider") a.provider = argv[++i];
    else if (k === "--allow-env-file") a.allowEnvFile = true;
    else if (k === "--help") a.help = true;
    else throw new Error("UNKNOWN_ARG");
  }
  return a;
}

// The only function in this module that may read a `.env` file.
function readEtherscanKeyFromEnvFile(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const root = options.root || ROOT;
  let raw;
  try {
    raw = fsImpl.readFileSync(path.join(root, ".env"), "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*ETHERSCAN_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
    if (m) {
      let v = m[1];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v || null;
    }
  }
  return null;
}

// Lazy, provider-gated key resolution. Never touches a `.env*` file unless the
// caller passed `--allow-env-file` and Etherscan is actually selected.
function loadEtherscanKey(options = {}) {
  const env = options.env || process.env;
  const fromEnv = typeof env.ETHERSCAN_API_KEY === "string" ? env.ETHERSCAN_API_KEY.trim() : "";
  if (fromEnv) return fromEnv;
  if (options.allowEnvFile === true) return readEtherscanKeyFromEnvFile(options);
  return null;
}

function etherscanKeyFor(args, steps, options = {}) {
  const etherscanSelected = steps.some(([name]) => name === "etherscan");
  if (!etherscanSelected) return { key: null, source: "not-selected", envFileRead: false };
  const env = options.env || process.env;
  const fromEnv = typeof env.ETHERSCAN_API_KEY === "string" ? env.ETHERSCAN_API_KEY.trim() : "";
  if (fromEnv) return { key: fromEnv, source: "process.env", envFileRead: false };
  if (args.allowEnvFile === true) {
    return { key: readEtherscanKeyFromEnvFile(options), source: "env-file", envFileRead: true };
  }
  return { key: null, source: "unavailable", envFileRead: false };
}

function resolveSteps(args) {
  let steps = [
    ["sourcify", trySourcify],
    ["etherscan", tryEtherscan],
    ["blockscout", tryBlockscout],
  ];
  if (args.provider) steps = steps.filter(([n]) => n === args.provider);
  if (steps.length === 0) throw new Error("BAD_PROVIDER");
  return steps;
}

function get(url, timeoutMs = 30000, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { accept: "application/json", "accept-encoding": "identity", "user-agent": "defensive-audit-explorer-fetch" } },
      (res) => {
        let n = 0;
        const chunks = [];
        res.on("data", (c) => {
          n += c.length;
          if (n > maxBytes) req.destroy(new Error("BYTE_CAP"));
          else chunks.push(Buffer.from(c));
        });
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("TIMEOUT")));
    req.on("error", reject);
  });
}

function normalizeSourcifySources(sources) {
  const out = {};
  for (const [p, v] of Object.entries(sources || {})) {
    const content = typeof v === "string" ? v : v && v.content;
    if (typeof content === "string") out[p] = content;
  }
  return out;
}

function parseEtherscanSourceCode(sourceCode, contractName, additional) {
  const sources = {};
  const trimmed = String(sourceCode || "").trim();
  if (trimmed.startsWith("{{") || trimmed.startsWith('{"language"') || trimmed.startsWith("{ ")) {
    let std = trimmed;
    if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) std = trimmed.slice(1, -1);
    try {
      const parsed = JSON.parse(std);
      if (parsed && parsed.sources) {
        for (const [p, v] of Object.entries(parsed.sources)) {
          const content = typeof v === "string" ? v : v && v.content;
          if (typeof content === "string") sources[p] = content;
        }
      }
    } catch {
      /* fall through to plain */
    }
  }
  if (Object.keys(sources).length === 0 && trimmed) sources[`${contractName || "Contract"}.sol`] = sourceCode;
  for (const extra of Array.isArray(additional) ? additional : []) {
    if (extra && extra.Filename && typeof extra.SourceCode === "string") sources[extra.Filename] = extra.SourceCode;
  }
  return sources;
}

async function trySourcify(chainId, address, getImpl = get) {
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=metadata,sources,compilation,deployment,proxyResolution`;
  const res = await getImpl(url);
  if (res.status !== 200) return { ok: false, reason: `HTTP_${res.status}` };
  const x = JSON.parse(res.body);
  const sources = normalizeSourcifySources(x.sources);
  if (Object.keys(sources).length === 0) return { ok: false, reason: "NO_SOURCES" };
  const pr = x.proxyResolution || {};
  const impls = Array.isArray(pr.implementations) ? pr.implementations : [];
  return {
    ok: true,
    provider: "sourcify",
    contractName: x.compilation && x.compilation.name ? x.compilation.name : null,
    compilerVersion: x.compilation && x.compilation.compilerVersion ? x.compilation.compilerVersion : null,
    match: x.match || null,
    runtimeMatch: x.runtimeMatch || null,
    // Authoritative: Sourcify proxyResolution.isProxy. Do NOT infer from the contract name
    // (name heuristics mis-flag e.g. Grove `ALMProxy`, which is a non-proxy capability proxy).
    proxy: pr.isProxy === true,
    proxySource: "sourcify:proxyResolution",
    implementation: impls[0] && impls[0].address ? impls[0].address : null,
    sources,
  };
}

async function tryEtherscan(chainId, address, apiKey, getImpl = get) {
  if (!apiKey) return { ok: false, reason: "NO_KEY" };
  const url =
    `https://api.etherscan.io/v2/api?chainid=${encodeURIComponent(chainId)}` +
    `&module=contract&action=getsourcecode&address=${encodeURIComponent(address)}` +
    `&apikey=${encodeURIComponent(apiKey)}`;
  const res = await getImpl(url);
  if (res.status !== 200) return { ok: false, reason: `HTTP_${res.status}` };
  const x = JSON.parse(res.body);
  if (String(x.status) !== "1" || !Array.isArray(x.result) || !x.result[0]) {
    return { ok: false, reason: String(x.message || "ES_ERROR").replace(/\s+/g, "_").slice(0, 60) };
  }
  const r = x.result[0];
  const sources = parseEtherscanSourceCode(r.SourceCode, r.ContractName, []);
  if (Object.keys(sources).length === 0) return { ok: false, reason: "NO_SOURCES" };
  return {
    ok: true,
    provider: "etherscan",
    contractName: r.ContractName || null,
    compilerVersion: r.CompilerVersion || null,
    match: r.Proxy === "1" ? "proxy" : "exact_or_partial",
    runtimeMatch: null,
    proxy: r.Proxy === "1",
    implementation: r.Implementation || null,
    sources,
  };
}

async function tryBlockscout(chainId, address, getImpl = get) {
  const host = BLOCKSCOUT_HOSTS[String(chainId)];
  if (!host) return { ok: false, reason: "NO_BLOCKSCOUT_HOST" };
  const url = `https://${host}/api/v2/smart-contracts/${address}`;
  const res = await getImpl(url);
  if (res.status !== 200) return { ok: false, reason: `HTTP_${res.status}` };
  const x = JSON.parse(res.body);
  const sources = {};
  if (typeof x.source_code === "string" && x.source_code.trim()) sources[`${x.name || "Contract"}.sol`] = x.source_code;
  for (const extra of Array.isArray(x.additional_sources) ? x.additional_sources : []) {
    if (extra && extra.file_path && typeof extra.source_code === "string") sources[extra.file_path] = extra.source_code;
  }
  if (Object.keys(sources).length === 0) return { ok: false, reason: "NO_SOURCES" };
  const impls = Array.isArray(x.implementations) ? x.implementations : [];
  const implAddr = impls[0] && (impls[0].address_hash || impls[0].address);
  return {
    ok: true,
    provider: "blockscout",
    contractName: x.name || null,
    compilerVersion: x.compiler_version || null,
    match: x.is_fully_verified ? "full" : x.is_verified ? "partial" : "unknown",
    runtimeMatch: null,
    proxy: !!implAddr,
    implementation: implAddr || null,
    sources,
  };
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

async function main(argv = process.argv.slice(2), options = {}) {
  const fsImpl = options.fsImpl || fs;
  const env = options.env || process.env;
  const getImpl = options.getImpl || get;
  const root = options.root || ROOT;
  const outRoot = options.outRoot || OUT_ROOT;

  const args = parseArgs(argv);
  if (args.help || !args.chain || !args.address) {
    console.log(USAGE);
    return { status: "USAGE" };
  }
  const chainId = String(args.chain);
  const address = String(args.address).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("BAD_ADDRESS");

  const steps = resolveSteps(args);
  const keyInfo = etherscanKeyFor(args, steps, { fsImpl, env, root });
  if (steps.length === 1 && steps[0][0] === "etherscan" && !keyInfo.key) {
    console.error(JSON.stringify({
      status: "FAIL_CLOSED",
      error: "ETHERSCAN_KEY_UNAVAILABLE",
      detail: "set process.env.ETHERSCAN_API_KEY or pass --allow-env-file with an Etherscan provider",
    }));
    return { status: "FAIL_CLOSED", error: "ETHERSCAN_KEY_UNAVAILABLE" };
  }
  const apiKey = keyInfo.key;

  async function resolve(addr, label) {
    const log = [];
    for (const [name] of steps) {
      try {
        const r = name === "sourcify" ? await trySourcify(chainId, addr, getImpl)
          : name === "etherscan" ? await tryEtherscan(chainId, addr, apiKey, getImpl)
            : await tryBlockscout(chainId, addr, getImpl);
        log.push(r.ok ? `${label}:${name}:OK` : `${label}:${name}:${r.reason}`);
        if (r.ok) return { result: r, log };
      } catch (e) {
        log.push(`${label}:${name}:error:${String(e.message || e).slice(0, 40)}`);
      }
    }
    return { result: null, log };
  }

  let attempts = [];
  const primary = await resolve(address, "primary");
  attempts = attempts.concat(primary.log);
  const result = primary.result;

  if (!result) {
    console.error(JSON.stringify({ status: "NO_SOURCE", chainId, address, attempts }));
    return { status: "NO_SOURCE", attempts };
  }

  // One-level proxy implementation resolution.
  let implBundle = null;
  if (result.implementation && String(result.implementation).toLowerCase() !== address.toLowerCase()) {
    const impl = await resolve(result.implementation, "impl");
    attempts = attempts.concat(impl.log);
    if (impl.result) {
      implBundle = {
        address: result.implementation,
        provider: impl.result.provider,
        contractName: impl.result.contractName,
        compilerVersion: impl.result.compilerVersion,
        match: impl.result.match,
        runtimeMatch: impl.result.runtimeMatch,
        sourceCount: Object.keys(impl.result.sources).length,
        sources: impl.result.sources,
      };
    }
  }

  const sourcePaths = Object.keys(result.sources);
  const slug = slugify(args.name || result.contractName || "contract");
  const dir = path.join(outRoot, `${slug}-${chainId}-${address.slice(2, 10)}`);
  fsImpl.mkdirSync(dir, { recursive: true });
  const bundle = {
    schema: "explorer-source-fetch/v1",
    retrievedAt: new Date().toISOString(),
    chainId,
    address,
    provider: result.provider,
    contractName: result.contractName,
    compilerVersion: result.compilerVersion,
    match: result.match,
    runtimeMatch: result.runtimeMatch,
    proxy: result.proxy || false,
    implementation: result.implementation || null,
    sourceCount: sourcePaths.length,
    sources: result.sources,
    implementationBundle: implBundle,
    safety: { publicVerifiedSourceOnly: true, keyPersisted: false, keyPrinted: false, readOnly: true },
  };
  const outPath = path.join(dir, "source-bundle.json");
  fsImpl.writeFileSync(outPath, JSON.stringify(bundle, null, 2) + "\n");
  console.log(
    JSON.stringify({
      status: "OK",
      provider: result.provider,
      chainId,
      address,
      contractName: result.contractName,
      compilerVersion: result.compilerVersion,
      match: result.match,
      sourceCount: sourcePaths.length,
      sourcePaths,
      implementation: result.implementation || null,
      implementationContract: implBundle ? implBundle.contractName : null,
      implementationSourceCount: implBundle ? implBundle.sourceCount : 0,
      output: path.relative(root, outPath).replaceAll("\\", "/"),
      attempts,
    })
  );
  return { status: "OK", provider: result.provider, outPath, attempts };
}

if (require.main === module) {
  main()
    .then((result) => {
      if (result && result.status && !["OK", "USAGE"].includes(result.status)) process.exitCode = 1;
    })
    .catch((e) => {
      console.error(JSON.stringify({ status: "FAIL_CLOSED", error: String(e.message || e).slice(0, 200) }));
      process.exitCode = 1;
    });
}

module.exports = {
  ROOT, OUT_ROOT, USAGE, BLOCKSCOUT_HOSTS, parseArgs, readEtherscanKeyFromEnvFile, loadEtherscanKey,
  etherscanKeyFor, resolveSteps, get, normalizeSourcifySources, parseEtherscanSourceCode,
  trySourcify, tryEtherscan, tryBlockscout, slugify, main,
};
