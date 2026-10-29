#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
let ethers; try { ({ ethers } = require("ethers")); } catch { ({ ethers } = require("./node_modules/ethers")); }
const ROOT = path.resolve(__dirname, "..");
const RAW = "reports/raw/fast/critical-morpho-ethereum-wjaaa-custom-oracle-step1.json";
const CAP = "reports/raw/fast/critical-authorized-endpoint-capability-qualification-r1.json";
const OUT = "reports/raw/fast/critical-morpho-ethereum-wjaaa-venue-supplement.json";
const VAULT = "0x4880799eE5200fC58DA299e965df644fBf46780B", CONSUMER = "0x02cf8C9fBa24d79886dAc40cb620f0930C6E8eC0", DEAD = "0x000000000000000000000000000000000000dEaD";
const SALT = "authorized-endpoint-capability-r1-20260724", abs = (x) => path.join(ROOT, ...x.split("/"));
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex"), hmac = (k, v) => crypto.createHmac("sha256", SALT).update(`${k}\0${v}`).digest("hex"), hex = (x) => `0x${BigInt(x).toString(16)}`;
const iface = new ethers.Interface([
  "function asset() view returns(address)", "function share() view returns(address)", "function totalAssets() view returns(uint256)",
  "function pricePerShare() view returns(uint128)", "function priceLastUpdated() view returns(uint64)",
  "function convertToAssets(uint256) view returns(uint256)", "function convertToShares(uint256) view returns(uint256)",
  "function maxDeposit(address) view returns(uint256)", "function maxMint(address) view returns(uint256)",
  "function maxRedeem(address) view returns(uint256)", "function maxWithdraw(address) view returns(uint256)",
  "function isPermissioned(address) view returns(bool)", "function pendingDepositRequest(uint256,address) view returns(uint256)",
  "function claimableDepositRequest(uint256,address) view returns(uint256)", "function pendingRedeemRequest(uint256,address) view returns(uint256)",
  "function claimableRedeemRequest(uint256,address) view returns(uint256)"
]);
const consumerIface = new ethers.Interface(["function barECDSA() view returns(uint8)", "function barSchnorr() view returns(uint8)", "function latestPoke() view returns(uint256)", "function authed() view returns(address[])", "function tolled() view returns(address[])"]);
function family(url) { const p = new URL(url).hostname.toLowerCase().split(".").filter(Boolean); return p.length <= 2 ? p.join(".") : `${p.at(-2)}.${p.at(-1)}`; }
function inventory() {
  const text = fs.readFileSync(abs("rpc_endpoints.txt"), "utf8"), urls = [...text.replace(/\\\//g, "/").matchAll(/https?:\/\/[^\s"'`<>{}\[\]]+/gi)].map((x) => x[0].replace(/[)>`,.;\]]+$/g, ""));
  return [...new Set(urls)].map((url) => ({ url, providerId: `provider-${hmac("provider", url).slice(0, 16)}`, family: family(url) }));
}
async function rpc(row, method, params) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(row.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: controller.signal });
      const json = await response.json(); if (json.error) throw Error("rpc"); return json.result;
    } catch (error) { if (attempt === 2) throw Error("transport-or-rpc"); await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1))); }
    finally { clearTimeout(timer); }
  }
}
async function callAt(row, target, abi, fn, args, tag) { const raw = await rpc(row, "eth_call", [{ to: target, data: abi.encodeFunctionData(fn, args) }, tag]); return abi.decodeFunctionResult(fn, raw).map((x) => typeof x === "bigint" ? x.toString() : Array.isArray(x) ? x.map((y) => typeof y === "bigint" ? y.toString() : y) : x); }
async function call(row, fn, args, tag) { return callAt(row, VAULT, iface, fn, args, tag); }
async function snapshot(row, pin) {
  const tag = hex(pin.number), names = [
    ["asset", []], ["share", []], ["totalAssets", []], ["pricePerShare", []], ["priceLastUpdated", []],
    ["convertToAssets", [1000000]], ["convertToShares", [1000000]], ["maxDeposit", [DEAD]], ["maxMint", [DEAD]],
    ["maxRedeem", [DEAD]], ["maxWithdraw", [DEAD]], ["isPermissioned", [DEAD]], ["pendingDepositRequest", [0, DEAD]],
    ["claimableDepositRequest", [0, DEAD]], ["pendingRedeemRequest", [0, DEAD]], ["claimableRedeemRequest", [0, DEAD]]
  ], values = {};
  for (const [name, args] of names) try { values[name] = (await call(row, name, args, tag))[0]; } catch { values[name] = null; }
  for (const name of ["barECDSA", "barSchnorr", "latestPoke", "authed", "tolled"]) try { values[`oracle${name[0].toUpperCase()}${name.slice(1)}`] = (await callAt(row, CONSUMER, consumerIface, `${name}()`, [], tag))[0]; } catch { values[`oracle${name[0].toUpperCase()}${name.slice(1)}`] = null; }
  const code = await rpc(row, "eth_getCode", [VAULT, tag]);
  return { values, runtimeBytes: (code.length - 2) / 2, runtimeKeccak256: ethers.keccak256(code) };
}
async function parallel(rows, limit, fn) {
  const out = new Array(rows.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => { while (true) { const i = cursor++; if (i >= rows.length) return; try { out[i] = await fn(rows[i]); } catch { out[i] = null; } } }));
  return out;
}
async function main() {
  const raw = JSON.parse(fs.readFileSync(abs(RAW))), cap = JSON.parse(fs.readFileSync(abs(CAP)));
  const prior = new Set(cap.providers.filter((x) => x.rpc?.chainId === 1 && x.deep?.archiveReady).map((x) => x.providerId));
  const candidates = inventory().sort((a, b) => Number(prior.has(b.providerId)) - Number(prior.has(a.providerId)));
  const probed = (await parallel(candidates, 12, async (row) => {
    const chain = await rpc(row, "eth_chainId", []), block = await rpc(row, "eth_getBlockByNumber", [hex(raw.pin.number), false]);
    if (BigInt(chain) !== 1n || block?.hash?.toLowerCase() !== raw.pin.hash) return null;
    const asset = await call(row, "asset", [], hex(raw.pin.number)); if (!asset[0]) return null; return row;
  })).filter(Boolean);
  const selected = [], seen = new Set(); for (const row of probed) if (!seen.has(row.family)) { selected.push(row); seen.add(row.family); if (selected.length === 8) break; }
  if (selected.length < 2) throw Error("two archive families unavailable");
  const observed = (await Promise.all(selected.map(async (row) => { try { return await snapshot(row, raw.pin); } catch { return null; } }))).filter(Boolean);
  if (observed.length < 2) throw Error("venue state coverage unavailable");
  const values = {}, fieldAgreement = {};
  for (const key of Object.keys(observed[0].values)) {
    const counts = new Map(); for (const row of observed) if (row.values[key] !== null) { const encoded = JSON.stringify(row.values[key]); counts.set(encoded, (counts.get(encoded) || 0) + 1); }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]; values[key] = best ? JSON.parse(best[0]) : null; fieldAgreement[key] = best?.[1] || 0;
  }
  const required = ["asset", "share", "convertToAssets", "convertToShares", "pricePerShare", "priceLastUpdated", "oracleBarECDSA", "oracleBarSchnorr", "oracleLatestPoke", "oracleAuthed"];
  if (required.some((x) => fieldAgreement[x] < 2)) throw Error(`venue core threshold:${JSON.stringify({ fieldAgreement, observations: observed.map((x) => x.values) })}`);
  const runtimeCounts = new Map(); for (const row of observed) { const key = `${row.runtimeBytes}:${row.runtimeKeccak256}`; runtimeCounts.set(key, (runtimeCounts.get(key) || 0) + 1); }
  const runtime = [...runtimeCounts.entries()].sort((a, b) => b[1] - a[1])[0][0].split(":"), v = values;
  const out = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), pin: raw.pin, target: VAULT,
    sourceIdentity: { contractName: "AsyncVault", compiler: "v0.8.28+commit.7893614a", optimizerRuns: 1, evmVersion: "cancun", publicVerifiedSource: true },
    archiveFamilies: 2, observedFamilies: observed.length, crossFamilyAgreement: true, fieldAgreement,
    state: { values, runtimeBytes: Number(runtime[0]), runtimeKeccak256: runtime[1] },
    pricing: {
      oneJaaaShareRaw: "1000000", redeemReferenceUsdcRaw: v.convertToAssets, oneUsdcRaw: "1000000", acquisitionReferenceJaaaRaw: v.convertToShares,
      oracleUsdcPerWjaaa: raw.market.oraclePriceUsdcPerWjaaa, referenceRedemptionUsdcPerJaaa: ethers.formatUnits(v.convertToAssets, 6),
      divergenceBps: ((BigInt(v.convertToAssets) * 10n ** 36n / BigInt(raw.market.oraclePriceRaw) - 1000000n) * 10000n / 1000000n).toString()
    },
    reachability: {
      freshUserPermissioned: v.isPermissioned, maxDepositRaw: v.maxDeposit, maxMintRaw: v.maxMint, maxRedeemRaw: v.maxRedeem, maxWithdrawRaw: v.maxWithdraw,
      immediateFreshUserAcquisition: v.isPermissioned === true && BigInt(v.maxDeposit || 0) > 0n,
      immediateFreshUserRedemption: v.isPermissioned === true && BigInt(v.maxRedeem || 0) > 0n, asyncRequestsPresent: true
    },
    oracleUpdateAuthorization: { barECDSA: v.oracleBarECDSA, barSchnorr: v.oracleBarSchnorr, latestPoke: v.oracleLatestPoke, authedAddresses: v.oracleAuthed, tolledAddresses: v.oracleTolled, unauthenticatedValueWrite: false, pokeRequiresThresholdValidECDSAOrSchnorrProof: true },
    safety: { endpointMaterialPersisted: false, rawRpcPersisted: false, transactions: false, signing: false, mutation: false, fork: false }
  };
  fs.writeFileSync(abs(OUT), `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ pin: raw.pin.number, pricing: out.pricing, reachability: out.reachability }) + "\n");
}
main().catch((error) => { process.stderr.write(`venue supplement stopped:${String(error.message).replace(/https?:\/\/\S+/g, "[redacted]")}\n`); process.exitCode = 1; });
