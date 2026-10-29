#!/usr/bin/env node
"use strict";
// Read-only verification for Reservoir CreditEnforcer fund-value step 2.
// Resolves chain-1 RPC in memory only; never prints/logs/persists endpoint values.
// No signing, no transactions, no state changes.

const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("ethers");
const { resolveRpc, rpcCall, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "reservoir-ce-fundvalue-step2.json");
const TIMEOUT_MS = 12_000;
const CHAIN_ID = 1;

const ADDR = {
  creditEnforcer: "0x04716DB62C085D9e08050fcF6F7D775A03d07720",
  rUsd: "0x09D4214C03D01F49544C0448DBE3A27f768F2b34",
  psmUsdc: "0x4809010926aec940b550D34a46A52739f996D75D",
  psmUsdt: "0xeaE91B4C84e1EDfA5d78dcae40962C7655A549B9",
  steakhouseHighYieldAdapter: "0xC5deA68CCe26c014BEC516CDA70c107c534a73C4",
  steakUsdcAdapter: "0x99A95a9E38e927486fC878f41Ff8b118Eb632b10",
};

const IFACE = new ethers.Interface([
  "function assetAdapterLength() view returns (uint256)",
  "function getAssetAdapterList(uint256 startIndex, uint256 length) view returns (address[])",
  "function psm() view returns (address)",
  "function assetRatioMin() view returns (uint256)",
  "function equityRatioMin() view returns (uint256)",
  "function liquidityRatioMin() view returns (uint256)",
  "function duration() view returns (uint256)",
  "function psmDebtMax() view returns (uint256)",
  "function allocate(uint256) view returns ()",
  // adapter probes
  "function fund() view returns (address)",
  "function underlying() view returns (address)",
  "function vault() view returns (address)",
  "function fundPriceOracle() view returns (address)",
  "function underlyingPriceOracle() view returns (address)",
  "function duration() view returns (uint256)",
  "function totalValue() view returns (uint256)",
  "function underlyingBalance() view returns (uint256)",
  "function fundBalance() view returns (uint256)",
  "function vaultBalance() view returns (uint256)",
  "function underlyingRiskWeight() view returns (uint256)",
  "function fundRiskWeight() view returns (uint256)",
  // fund / erc20 / erc4626 probes
  "function currentPrice() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function userDeposits(address) view returns (uint256, uint256)",
  "function userRedemptions(address) view returns (uint256, uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function paused() view returns (bool)",
  // psm
  "function underlyingBalance() view returns (uint256)",
  "function totalValue() view returns (uint256)",
  "function stablecoin() view returns (address)",
]);

function enc(fn, args = []) {
  return IFACE.encodeFunctionData(fn, args);
}

async function call(rpc, to, fn, args = [], block = "latest") {
  try {
    const data = enc(fn, args);
    const raw = await rpcCall(rpc, "eth_call", [{ to, data }, block], TIMEOUT_MS);
    if (!raw || raw === "0x") return null;
    const out = IFACE.decodeFunctionResult(fn, raw);
    return out.length === 1 ? out[0] : out;
  } catch (_) {
    return null;
  }
}

async function codeSize(rpc, addr) {
  const code = await rpcCall(rpc, "eth_getCode", [addr, "latest"], TIMEOUT_MS);
  if (typeof code !== "string" || !/^0x[0-9a-f]*$/i.test(code)) return null;
  return (code.length - 2) / 2;
}

function num(v) {
  if (v === null || v === undefined) return null;
  try { return v.toString(); } catch (_) { return null; }
}

async function main() {
  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) {
    fs.writeFileSync(OUT, JSON.stringify({ ok: false, error: "NO_RPC" }, null, 2));
    console.log("NO_RPC");
    process.exitCode = 2;
    return;
  }

  const out = { ok: true, chainId: CHAIN_ID, generatedAt: new Date().toISOString(), creditEnforcer: {}, adapters: [], funds: {}, psm: {}, knownAdapters: {} };

  // --- CreditEnforcer config ---
  out.creditEnforcer.assetAdapterLength = num(await call(rpc, ADDR.creditEnforcer, "assetAdapterLength"));
  out.creditEnforcer.psm = await call(rpc, ADDR.creditEnforcer, "psm");
  out.creditEnforcer.assetRatioMin = num(await call(rpc, ADDR.creditEnforcer, "assetRatioMin"));
  out.creditEnforcer.equityRatioMin = num(await call(rpc, ADDR.creditEnforcer, "equityRatioMin"));
  out.creditEnforcer.liquidityRatioMin = num(await call(rpc, ADDR.creditEnforcer, "liquidityRatioMin"));
  out.creditEnforcer.duration = num(await call(rpc, ADDR.creditEnforcer, "duration"));
  out.creditEnforcer.psmDebtMax = num(await call(rpc, ADDR.creditEnforcer, "psmDebtMax"));

  const len = out.creditEnforcer.assetAdapterLength ? Number(out.creditEnforcer.assetAdapterLength) : 0;
  let list = [];
  if (len > 0 && len <= 64) {
    const arr = await call(rpc, ADDR.creditEnforcer, "getAssetAdapterList", [0, len]);
    if (Array.isArray(arr)) list = arr[0] || arr;
    else if (arr) list = arr;
  }
  out.creditEnforcer.assetAdapterList = list;

  // --- Per-adapter probe ---
  const adapterAddrs = new Set([...list.map((a) => String(a))]);
  // Include known adapters as labeled probes even if not wired.
  const labeled = [
    ["steakhouseHighYieldAdapter", ADDR.steakhouseHighYieldAdapter],
    ["steakUsdcAdapter", ADDR.steakUsdcAdapter],
  ];

  async function probeAdapter(address, label) {
    const a = { label, address, codeSize: await codeSize(rpc, address), wired: adapterAddrs.has(address) };
    a.fund = await call(rpc, address, "fund");
    a.vault = await call(rpc, address, "vault");
    a.underlying = await call(rpc, address, "underlying");
    a.fundPriceOracle = await call(rpc, address, "fundPriceOracle");
    a.underlyingPriceOracle = await call(rpc, address, "underlyingPriceOracle");
    a.duration = num(await call(rpc, address, "duration"));
    a.totalValue = num(await call(rpc, address, "totalValue"));
    a.underlyingBalance = num(await call(rpc, address, "underlyingBalance"));
    a.fundBalance = num(await call(rpc, address, "fundBalance"));
    a.vaultBalance = num(await call(rpc, address, "vaultBalance"));
    a.underlyingRiskWeight = num(await call(rpc, address, "underlyingRiskWeight"));
    a.fundRiskWeight = num(await call(rpc, address, "fundRiskWeight"));
    return a;
  }

  for (const addr of list) out.adapters.push(await probeAdapter(addr, "wired"));
  for (const [label, addr] of labeled) {
    const p = await probeAdapter(addr, label);
    out.knownAdapters[label] = p;
    if (p.fund) out.adapters.push(p);
  }

  // dedupe fund probes
  const fundAddrs = new Set();
  for (const a of out.adapters) if (a.fund && a.fund !== ethers.ZeroAddress) fundAddrs.add(a.fund);

  for (const f of fundAddrs) {
    const rec = { address: f, codeSize: await codeSize(rpc, f) };
    rec.impl = await getImpl(rpc, f);
    rec.currentPrice = num(await call(rpc, f, "currentPrice"));
    rec.totalAssets = num(await call(rpc, f, "totalAssets"));
    rec.totalSupply = num(await call(rpc, f, "totalSupply"));
    rec.symbol = await call(rpc, f, "symbol");
    const holder = out.adapters.find((a) => a.fund === f && a.address);
    if (holder) {
      rec.adapter = holder.address;
      rec.adapterFundBalance = num(await call(rpc, f, "balanceOf", [holder.address]));
      const ud = await call(rpc, f, "userDeposits", [holder.address]);
      rec.adapterUserDeposits = ud ? ud.map(String) : null;
      const ur = await call(rpc, f, "userRedemptions", [holder.address]);
      rec.adapterUserRedemptions = ur ? ur.map(String) : null;
    }
    out.funds[f] = rec;
  }

  // --- PSM state (both known PSMs + wired psm from CE) ---
  const psmAddrs = new Set([ADDR.psmUsdc, ADDR.psmUsdt]);
  if (out.creditEnforcer.psm) psmAddrs.add(out.creditEnforcer.psm);
  for (const p of psmAddrs) {
    out.psm[p] = {
      codeSize: await codeSize(rpc, p),
      underlyingBalance: num(await call(rpc, p, "underlyingBalance")),
      totalValue: num(await call(rpc, p, "totalValue")),
      paused: await call(rpc, p, "paused"),
      stablecoin: await call(rpc, p, "stablecoin"),
    };
  }

  // --- rUSD supply ---
  out.rUsd = { totalSupply: num(await call(rpc, ADDR.rUsd, "totalSupply")) };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({
    ok: true,
    assetAdapterLength: out.creditEnforcer.assetAdapterLength,
    adapters: out.adapters.map((a) => ({ label: a.label, address: a.address, wired: a.wired, fund: a.fund, vault: a.vault, totalValue: a.totalValue })),
    funds: Object.keys(out.funds).length,
    out: path.relative(WORKSPACE, OUT),
  }));
}

main().catch((e) => {
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, error: "INTERNAL" }, null, 2));
  console.log("INTERNAL_ERROR");
  process.exitCode = 1;
});
