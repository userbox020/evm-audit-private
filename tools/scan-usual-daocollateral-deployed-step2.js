#!/usr/bin/env node
"use strict";
// Read-only deployed-wiring verification for Usual DaoCollateral (Ethereum mainnet).
// Uses tools/shared-rpc.js resolution; endpoint URLs stay process-only and are never printed.
// No signing, no transactions, no state changes. Findings-only defensive evidence capture.
const fs = require("fs");
const path = require("path");
const { ethers } = require("./node_modules/ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc.js");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports/raw/fast/usual-daocollateral-deployed-step2.json");

const PROXY = "0xde6e1F680C4816446C8D515989E2358636A38b04";
const EXPECTED_IMPL = "0x0eEc861D49f15F585D6Bb4301FC4f89BCe22AF4e";
const EXPECTED_ADMIN = "0xaaDa24358620d4638a2eE8788244c6F4b197Ca16";

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const INITIALIZABLE = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
const DC_BASE = BigInt("0xb6b5806749b83e5a37ff64f3aa7a7ce3ac6e8a80a998e853c1d3efe545237c00");

const OFF = {
  flags: 0n, redeemFee: 1n, cbrCoef: 2n, registryAccess: 3n, registryContract: 4n,
  tokenMapping: 5n, usd0: 6n, oracle: 7n, treasury: 8n, swapperEngine: 9n,
  nonceThreshold: 10n, treasuryYield: 12n,
};

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const iface = new ethers.Interface([
  "function getContract(bytes32) view returns (address)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function getPrice(address) view returns (uint256)",
  "function getAllUsd0Rwa() view returns (address[])",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

function slotFor(base, offset) { return ethers.toBeHex(base + offset, 32); }
function addrFromWord(w) { return ethers.getAddress("0x" + w.slice(26)); }
function log() {} // never print endpoint material

async function main() {
  const url = await resolveRpc(1);
  if (!url) { console.error(JSON.stringify({ status: "NO_RPC" })); process.exitCode = 1; return; }
  const bnHex = await rpcCall(url, "eth_blockNumber", []);
  const block = bnHex;
  const at = (method, params) => rpcCall(url, method, params, 12000).catch(() => null);

  const sget = async (addr, slot) => {
    const v = await at("eth_getStorageAt", [addr, slot, block]);
    return /^0x[0-9a-fA-F]{64}$/.test(v || "") ? v : null;
  };
  const call = async (to, data) => {
    const v = await at("eth_call", [{ to, data }, block]);
    return typeof v === "string" && v !== "0x" ? v : null;
  };
  const nameHash = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
  const staticCall = (to, fn, args) => call(to, iface.encodeFunctionData(fn, args));
  const decode = (fn, raw) => { try { return iface.decodeFunctionResult(fn, raw); } catch { return null; } };

  const implWord = await sget(PROXY, EIP1967_IMPL);
  const adminWord = await sget(PROXY, EIP1967_ADMIN);
  const initWord = await sget(PROXY, INITIALIZABLE);
  const flagsWord = await sget(PROXY, slotFor(DC_BASE, OFF.flags));
  const fields = {};
  for (const [k, o] of Object.entries(OFF)) {
    if (k === "flags") continue;
    const w = await sget(PROXY, slotFor(DC_BASE, o));
    fields[k] = w ? addrFromWord(w) : null;
    fields[k + "_word"] = w;
  }

  const impl = implWord ? addrFromWord(implWord) : null;
  const admin = adminWord ? addrFromWord(adminWord) : null;
  // Initializable: uint64 _initialized in first 8 bytes (low-order in the slot word)
  let initVersion = null;
  if (initWord && /^0x[0-9a-fA-F]{64}$/.test(initWord)) {
    const low = BigInt("0x" + initWord.slice(2));
    const initialized = low & ((1n << 64n) - 1n);
    const initializing = (low >> 64n) & 1n;
    initVersion = { initialized: initialized.toString(), initializing: Boolean(initializing) };
  }

  const registry = fields.registryContract;
  const registryReads = {};
  if (registry && registry !== ZERO_ADDR) {
    for (const n of ["CONTRACT_DAO_COLLATERAL", "CONTRACT_SWAPPER_ENGINE", "CONTRACT_ORACLE", "CONTRACT_TREASURY", "CONTRACT_TOKEN_MAPPING", "CONTRACT_YIELD_TREASURY"]) {
      const raw = await staticCall(registry, "getContract", [nameHash(n)]);
      const d = raw ? decode("getContract", raw) : null;
      registryReads[n] = d ? ethers.getAddress(d[0]) : null;
    }
  }

  const regAccess = fields.registryAccess;
  const roleReads = {};
  if (regAccess && regAccess !== ZERO_ADDR) {
    for (const r of ["USD0_MINT", "USD0_BURN", "DEFAULT_ADMIN_ROLE", "PAUSING_CONTRACTS_ROLE", "INTENT_MATCHING_ROLE", "NONCE_THRESHOLD_SETTER_ROLE"]) {
      const raw = await staticCall(regAccess, "hasRole", [r === "DEFAULT_ADMIN_ROLE" ? ethers.ZeroHash : nameHash(r), PROXY]);
      const d = raw ? decode("hasRole", raw) : null;
      roleReads[r] = d ? d[0] : null;
    }
  }

  // RWA token list + oracle reads + treasury balances
  let rwa = [];
  if (fields.tokenMapping && fields.tokenMapping !== ZERO_ADDR) {
    const raw = await staticCall(fields.tokenMapping, "getAllUsd0Rwa", []);
    const d = raw ? decode("getAllUsd0Rwa", raw) : null;
    const list = d && d[0] ? Array.from(d[0]) : [];
    for (const t of list) {
      const decRaw = await staticCall(t, "decimals", []);
      const symRaw = await staticCall(t, "symbol", []);
      const dec = decRaw ? decode("decimals", decRaw) : null;
      const sym = symRaw ? decode("symbol", symRaw) : null;
      let price = null, priceReverted = false;
      if (fields.oracle && fields.oracle !== ZERO_ADDR) {
        const pRaw = await staticCall(fields.oracle, "getPrice", [t]);
        const pd = pRaw ? decode("getPrice", pRaw) : null;
        if (pd) price = pd[0].toString(); else priceReverted = true;
      }
      let treasuryBal = null;
      if (fields.treasury && fields.treasury !== ZERO_ADDR) {
        const bRaw = await staticCall(t, "balanceOf", [fields.treasury]);
        const bd = bRaw ? decode("balanceOf", bRaw) : null;
        treasuryBal = bd ? bd[0].toString() : null;
      }
      rwa.push({ token: ethers.getAddress(t), symbol: sym ? sym[0] : null, decimals: dec ? Number(dec[0]) : null, oraclePriceWad: price, oracleReverted: priceReverted, treasuryBalance: treasuryBal });
    }
  }

  let usd0 = null;
  if (fields.usd0 && fields.usd0 !== ZERO_ADDR) {
    const tsRaw = await staticCall(fields.usd0, "totalSupply", []);
    const d = tsRaw ? decode("totalSupply", tsRaw) : null;
    const decRaw = await staticCall(fields.usd0, "decimals", []);
    usd0 = { address: ethers.getAddress(fields.usd0), totalSupply: d ? d[0].toString() : null, decimals: decRaw ? Number(decode("decimals", decRaw)[0]) : null };
  }

  let yieldTreasury = null;
  if (fields.treasuryYield && fields.treasuryYield !== ZERO_ADDR && fields.usd0) {
    const bRaw = await staticCall(fields.usd0, "balanceOf", [fields.treasuryYield]);
    const bd = bRaw ? decode("balanceOf", bRaw) : null;
    yieldTreasury = { address: ethers.getAddress(fields.treasuryYield), usd0Balance: bd ? bd[0].toString() : null };
  }

  const flags = flagsWord ? {
    redeemPaused: Boolean(BigInt(flagsWord) & 1n),
    swapPaused: Boolean((BigInt(flagsWord) >> 8n) & 1n),
    cbrOn: Boolean((BigInt(flagsWord) >> 16n) & 1n),
  } : null;

  const out = {
    schema: "usual-daocollateral-deployed-step2/v1",
    retrievedAt: new Date().toISOString(),
    chainId: 1,
    pinnedBlock: BigInt(block).toString(),
    safety: { readOnly: true, noSigning: true, noBroadcast: true, endpointMaterialPrinted: false, keyPersisted: false },
    proxy: { address: PROXY, impl, expectedImpl: EXPECTED_IMPL, implMatches: impl && impl.toLowerCase() === EXPECTED_IMPL.toLowerCase(), admin, expectedAdmin: EXPECTED_ADMIN, adminMatches: admin && admin.toLowerCase() === EXPECTED_ADMIN.toLowerCase(), initializable: initVersion },
    fields: {
      redeemFee: fields.redeemFee_word ? BigInt(fields.redeemFee_word).toString() : null,
      cbrCoef: fields.cbrCoef_word ? BigInt(fields.cbrCoef_word).toString() : null,
      registryAccess: fields.registryAccess, registryContract: registry, tokenMapping: fields.tokenMapping,
      usd0: fields.usd0, oracle: fields.oracle, treasury: fields.treasury, swapperEngine: fields.swapperEngine,
      nonceThreshold: fields.nonceThreshold_word ? BigInt(fields.nonceThreshold_word).toString() : null,
      treasuryYield: fields.treasuryYield, flags,
    },
    registryReads,
    bindingChecks: {
      swapperEngineEqRegistry: registryReads.CONTRACT_SWAPPER_ENGINE && fields.swapperEngine ? registryReads.CONTRACT_SWAPPER_ENGINE.toLowerCase() === fields.swapperEngine.toLowerCase() : null,
      oracleEqRegistry: registryReads.CONTRACT_ORACLE && fields.oracle ? registryReads.CONTRACT_ORACLE.toLowerCase() === fields.oracle.toLowerCase() : null,
      treasuryEqRegistry: registryReads.CONTRACT_TREASURY && fields.treasury ? registryReads.CONTRACT_TREASURY.toLowerCase() === fields.treasury.toLowerCase() : null,
      tokenMappingEqRegistry: registryReads.CONTRACT_TOKEN_MAPPING && fields.tokenMapping ? registryReads.CONTRACT_TOKEN_MAPPING.toLowerCase() === fields.tokenMapping.toLowerCase() : null,
      yieldTreasuryEqRegistry: registryReads.CONTRACT_YIELD_TREASURY && fields.treasuryYield ? registryReads.CONTRACT_YIELD_TREASURY.toLowerCase() === fields.treasuryYield.toLowerCase() : null,
      registryDaoCollateralEqProxy: registryReads.CONTRACT_DAO_COLLATERAL ? registryReads.CONTRACT_DAO_COLLATERAL.toLowerCase() === PROXY.toLowerCase() : null,
    },
    roleReads,
    rwa,
    usd0,
    yieldTreasury,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({
    status: "OK", pinnedBlock: out.pinnedBlock,
    implMatches: out.proxy.implMatches, adminMatches: out.proxy.adminMatches, initializable: initVersion,
    bindingChecks: out.bindingChecks, roleReads, flags,
  }, null, 2));
}

main().catch((e) => { console.error(JSON.stringify({ status: "FAIL_CLOSED", error: String(e && e.message || e).slice(0, 160) })); process.exitCode = 1; });
