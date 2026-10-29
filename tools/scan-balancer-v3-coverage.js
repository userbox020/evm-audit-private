#!/usr/bin/env node
"use strict";

// Bounded, read-only Balancer V3 flash-liquidity/fee (F) observation.
//
// At a finalized pin on Ethereum (1) and Base (8453) this reads:
// - the V3 Vault address re-derived from a declared registered pool's `getVault()`
//   (provenance binding: the Vault is discovered on-chain, never assumed), and
// - the V3 Vault's own ERC20 balance of every declared flash token (the liquidity a
//   permissionless `flashLoan` can source at the pin).
//
// Balancer V3 charges no flash-loan fee and the deployed Vault exposes no
// fee getter, so the fee is declared as the zero protocol constant and recorded as
// such. RPC endpoint material stays process-only and is never printed or persisted.
//
// X (Router swap round trip) and R (add/remove-liquidity round trip) are NOT
// produced here: both require the V3 Router's `query*` view functions, and no V3
// Router address is bound in-repo (the July source work is source-absent, and the
// V3 GraphQL SOR endpoint is not serving). Those rows stay recognized BLOCKED gap
// binders.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { rpcCall } = require("./shared-rpc");
const { resolveWorkingRpc } = require("./scan-morpho-blue-l");
const audit = require("./audit-trigger-coverage-universe.js");

const WORKSPACE = path.resolve(__dirname, "..");
const COVERAGE_DIR = path.join(WORKSPACE, "reports", "monitor", "trigger-coverage");
const RAW_PATH = path.join(WORKSPACE, "reports", "raw", "fast", "balancer-v3-flash-liquidity.json");
const TIMEOUT_MS = 15_000;
const FLASH_COVERAGE_REF = "bounded flash-liquidity and fee observation";
const SCANNER = "tools/scan-balancer-v3-coverage.js";
const BINDER_SCHEMA = "trigger-coverage-evidence/v1";
const RAW_SCHEMA = "balancer-v3-flash-liquidity/v1";

// The V3 Vault is a cross-chain singleton. It is re-verified on-chain from the
// declared provenance pool on every run.
const VAULT = "0xbA1333333333a1BA1108E8412f11850A5C319bA9";
const CHAINS = Object.freeze({
  1: Object.freeze({
    name: "Ethereum",
    provenancePool: "0xaE255Db04BA78519f33871c557d8fd6bafDb83bD",
    binderPath: path.join(COVERAGE_DIR, "balancer-v3-ethereum-f.json"),
    tokens: Object.freeze([
      Object.freeze({ symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 }),
      Object.freeze({ symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 }),
      Object.freeze({ symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18 }),
      Object.freeze({ symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18 }),
    ]),
  }),
  8453: Object.freeze({
    name: "Base",
    provenancePool: "0x5ed0F614992F9bea27bE5641641cc87580747945",
    binderPath: path.join(COVERAGE_DIR, "balancer-v3-base-f.json"),
    tokens: Object.freeze([
      Object.freeze({ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }),
      Object.freeze({ symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18 }),
    ]),
  }),
});

const VAULT_I = new ethers.Interface(["function getVault() view returns (address)"]);
const ERC20_I = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);

class ScanFailure extends Error {
  constructor(code) { super(code); this.name = "ScanFailure"; this.code = code; }
}
function fail(code) { throw new ScanFailure(code); }
function sameAddress(a, b) { return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase(); }
function sanitizeFailure(error) {
  const allowed = new Set(["RPC_UNAVAILABLE", "BLOCK_UNAVAILABLE", "CALL_FAILED", "EMPTY_CODE", "ABI_DECODE_FAILED", "VAULT_PROVENANCE_MISMATCH"]);
  return allowed.has(error && error.code) ? error.code : "CALL_FAILED";
}
function relPosix(target) { return path.relative(WORKSPACE, target).split(path.sep).join("/"); }

async function callDecoded(rpc, target, iface, fn, args, blockTag, rpcCallImpl) {
  const data = iface.encodeFunctionData(fn, args);
  const raw = await rpcCallImpl(rpc, "eth_call", [{ to: target, data }, blockTag], TIMEOUT_MS);
  if (typeof raw !== "string" || !/^0x[0-9a-f]*$/i.test(raw) || raw === "0x") fail("CALL_FAILED");
  try { return iface.decodeFunctionResult(fn, raw); } catch (_) { fail("ABI_DECODE_FAILED"); }
}
async function requireCode(rpc, address, blockTag, rpcCallImpl) {
  const code = await rpcCallImpl(rpc, "eth_getCode", [address, blockTag], TIMEOUT_MS);
  if (typeof code !== "string" || !/^0x[0-9a-f]+$/i.test(code) || code === "0x") fail("EMPTY_CODE");
}
function validatePinBlock(block) {
  if (!block || !/^0x[0-9a-f]+$/i.test(block.number || "") || !/^0x[0-9a-f]{64}$/i.test(block.hash || "")) fail("BLOCK_UNAVAILABLE");
  return true;
}
async function selectPin(rpc, rpcCallImpl) {
  const block = await rpcCallImpl(rpc, "eth_getBlockByNumber", ["finalized", false], TIMEOUT_MS);
  validatePinBlock(block);
  return { block, blockTag: block.number, finality: "finalized" };
}

async function scanChain(chainId, options = {}) {
  const config = CHAINS[chainId];
  if (!config) fail("CHAIN_UNSUPPORTED");
  const rpcCallImpl = options.rpcCall || rpcCall;
  const resolveRpcImpl = options.resolveRpc || resolveWorkingRpc;
  const rpc = await resolveRpcImpl(chainId);
  if (!rpc) fail("RPC_UNAVAILABLE");
  const { block, blockTag, finality } = await selectPin(rpc, rpcCallImpl);

  const reads = { attempted: 1 + config.tokens.length, succeeded: 0, failed: 0, unclassifiedFailures: 0 };
  const errors = [];
  let provenanceVault = null;
  await requireCode(rpc, config.provenancePool, blockTag, rpcCallImpl);
  await requireCode(rpc, VAULT, blockTag, rpcCallImpl);
  const [vault] = await callDecoded(rpc, config.provenancePool, VAULT_I, "getVault", [], blockTag, rpcCallImpl);
  if (!sameAddress(vault, VAULT)) fail("VAULT_PROVENANCE_MISMATCH");
  provenanceVault = ethers.getAddress(vault);
  reads.succeeded += 1;

  const balances = [];
  for (const token of config.tokens) {
    try {
      const [balance] = await callDecoded(rpc, token.address, ERC20_I, "balanceOf", [VAULT], blockTag, rpcCallImpl);
      balances.push({ symbol: token.symbol, token: token.address, decimals: token.decimals, balanceRaw: BigInt(balance).toString() });
      reads.succeeded += 1;
    } catch (error) {
      reads.failed += 1;
      errors.push({ token: token.symbol, error: sanitizeFailure(error) });
    }
  }

  const recheck = await rpcCallImpl(rpc, "eth_getBlockByHash", [block.hash, false], TIMEOUT_MS);
  if (!recheck || String(recheck.hash).toLowerCase() !== String(block.hash).toLowerCase() || recheck.number !== block.number) fail("BLOCK_UNAVAILABLE");

  const blockTimestamp = Number(BigInt(block.timestamp));
  return {
    chainId,
    chain: config.name,
    vault: VAULT,
    provenancePool: config.provenancePool,
    provenanceVault,
    flashLoanFeeBps: 0,
    flashLoanFeeNote: "Balancer V3 flash loans carry no fee; the deployed Vault exposes no fee getter",
    declaredTokens: config.tokens.map((token) => token.symbol),
    balances,
    reads,
    errors,
    complete: reads.failed === 0 && reads.succeeded === reads.attempted,
    pin: {
      number: Number(BigInt(block.number)),
      hash: block.hash,
      timestamp: new Date(blockTimestamp * 1000).toISOString(),
      finality,
    },
  };
}

async function scan(options = {}) {
  const chainIds = options.chainIds || Object.keys(CHAINS).map(Number);
  const scannedAt = new Date(options.now || Date.now()).toISOString();
  const chains = [];
  for (const chainId of chainIds) chains.push(await scanChain(chainId, options));
  return {
    schema: RAW_SCHEMA,
    scanner: SCANNER,
    scannedAt,
    safety: { readOnly: true, signedActions: false, transactions: false, approvals: false, swaps: false, flashLoans: false, endpointMaterialPersisted: false },
    chains,
    routePositive: 0,
    executableNow: 0,
  };
}

function coverageEvidence(chain, artifact) {
  const covered = chain.complete === true;
  const balances = chain.balances.map((row) => `${row.symbol}=${row.balanceRaw}`).join(", ") || "none";
  return {
    schema: BINDER_SCHEMA,
    observedAt: artifact.scannedAt,
    chainId: chain.chainId,
    family: "Balancer V3",
    triggerClass: "F",
    enumeration: { kind: "BOUNDED_ARTIFACT", ref: FLASH_COVERAGE_REF, boundDeclared: true, successful: covered },
    reads: chain.reads,
    classSemantics: { triggerClass: "F", exact: true },
    coverage: { complete: covered },
    onFire: { economics: true, keylessFixedPinFork: true, alert: true },
    dispatchEnabled: covered,
    evidence: [
      `${relPosix(RAW_PATH)}#chains.${chain.chainId}`,
      `finalized pin ${chain.pin.number} hash ${chain.pin.hash}`,
      `Balancer V3 Vault ${chain.vault} re-derived on-chain from registered pool ${chain.provenancePool} getVault()`,
      `Vault flash-loan fee ${chain.flashLoanFeeBps} bps (${chain.flashLoanFeeNote})`,
      `Vault flash-token balances: ${balances}`,
    ],
    blockers: covered ? [] : [
      `${chain.reads.failed} of ${chain.reads.attempted} Vault flash-liquidity reads failed`,
      ...chain.errors.map((row) => `${row.token} read failed: ${row.error}`),
    ],
  };
}

function publish(artifact, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const rawPath = options.rawPath || RAW_PATH;
  fsImpl.mkdirSync(path.dirname(rawPath), { recursive: true });
  fsImpl.writeFileSync(rawPath, `${JSON.stringify(artifact, null, 2)}\n`);
  const written = [];
  for (const chain of artifact.chains) {
    const target = CHAINS[chain.chainId].binderPath;
    audit.atomicWriteJson(target, coverageEvidence(chain, artifact), { fsImpl });
    written.push(relPosix(target));
  }
  return { rawPath, written };
}

// Refresh hook for a scheduled surface: scans every chain and writes raw + binders.
async function refresh(options = {}) {
  const artifact = await scan(options);
  const result = publish(artifact, options);
  return Object.freeze({ scannedAt: artifact.scannedAt, chains: artifact.chains.length, written: result.written });
}

async function main(argv = process.argv.slice(2)) {
  try {
    const unknown = argv.filter((arg) => arg !== "--check");
    if (unknown.length) throw new Error("usage: scan-balancer-v3-coverage.js [--check]");
    if (argv.includes("--check")) {
      for (const [chainId, config] of Object.entries(CHAINS)) {
        if (!config.tokens.length) throw new Error(`no declared flash tokens for chain ${chainId}`);
      }
      process.stdout.write(`balancer-v3-coverage check ok: chains=${Object.keys(CHAINS).length} vault=${VAULT}\n`);
      return;
    }
    const result = await refresh({});
    process.stdout.write(`balancer-v3-coverage scanned: chains=${result.chains} written=${result.written.length} scannedAt=${result.scannedAt}\n`);
    for (const file of result.written) process.stdout.write(`balancer-v3-coverage wrote ${file}\n`);
  } catch (error) {
    process.stderr.write(`balancer-v3-coverage failed closed: ${sanitizeFailure(error)}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  WORKSPACE, COVERAGE_DIR, RAW_PATH, VAULT, CHAINS, FLASH_COVERAGE_REF, SCANNER, BINDER_SCHEMA, RAW_SCHEMA,
  ScanFailure, sameAddress, sanitizeFailure, callDecoded, requireCode, validatePinBlock, selectPin,
  scanChain, scan, coverageEvidence, publish, refresh, main,
};
