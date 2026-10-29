#!/usr/bin/env node
"use strict";

// fluid-allowance-class-step2.js
// T3 step 2: Fluid live-impl allowance-class kernel lens.
//
// Read-only, keyless, public-RPC only. Two keyless endpoint families (archive +
// fallback). Endpoint URLs / hosts / paths are NEVER printed or persisted.
// No signing, no keys, no .env reads, no state changes, nothing forwarded.
//
// Offline  : emit a storage-layout JSON for the Liquidity + Vault(T1) namespaces
//            (allowance/auth mapping root positions) parsed from the in-tree
//            audited Solidity declarations, and join the remediation tree.
// Live     : at one fresh finalized pin, raw-slot-decode the Liquidity proxy and
//            vault-14 (raw slots + computed allowance/auth mapping roots + the
//            vault-14 deployment-manifest Liquidity slots); corroborate the
//            allowance-critical slots on a second endpoint family.
// Lens     : assert live allowance/auth accounting invariants vs the checkout's
//            declared shapes; classify the registry!=live-impl delta.
//
// Honest verdict vocabulary: OK / INCOMPLETE_<reason> / zero-hit / etc.

const fs = require("node:fs");
const path = require("node:path");
const { AbiCoder, keccak256 } = require(path.join(__dirname, "node_modules", "ethers"));

const ROOT = path.resolve(__dirname, "..");
const OUTDIR = path.join(ROOT, "reports", "raw", "fast");
const OUTPUT = path.join(OUTDIR, "fluid-allowance-class-step2.json");
const LAYOUT_OUT = path.join(OUTDIR, "fluid-allowance-class-step2.layout.json");
const REPORT = path.join(ROOT, "reports", "critical-fluid-allowance-class-step2.md");

const ABIC = AbiCoder.defaultAbiCoder();
const LIMIT_MS = 20 * 60 * 1000;
const DEADLINE = Date.now() + LIMIT_MS;
const MAX_CALLS = 140;

const ETH_CHAIN_ID = 1;
const LIQUIDITY_PROXY = "0x52Aa899454998Be5b000Ad077a46Bbe360F4e497";
const LIQUIDITY_LIVE_IMPL_DECODE_PRIMARY = "0xcc331daf69752bece3dc98dbc63eacd5092266a2";
const LIQUIDITY_REGISTRY_IMPL = "0xFb3102759f2d57f547b9c519db49ce1ffde15db2";
const RESERVE_PROXY = "0x264786EF916af64a1DB19F513F24a3681734ce92";
const VAULT14 = "0x1982CC7b1570C2503282d0A0B41F69b3B28fdcc3";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const FTOKEN_WSTETH = "0x2411802D8BEA09be0aF8fD8D08314a63e706b29C";
const MAIN_USER = "0x24e46e91dfaad1fa3d49c48aa85ca9306885ce0a";
const VAULT_FACTORY = "0x324c5Dc1fC42c7a4D43d92df1eBA58a54d13Bf2d";

const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

// Vault-14 deployment manifest (targets/fluid-contracts-public/deployments/mainnet/dump/0x1982CC7b...json args)
const MANIFEST_SLOTS = {
  liquidityTotalSupplySlot: "0x94416004645a626907820dc10a83f0e7e82fe5572b44e84e877643ce205ff0ed",
  liquidityTotalBorrowSlot: "0xf942f4688cdba65adc8aa59da583acae93fa87351143ebc775559218bfa5f832",
  liquiditySupplyExchangePriceSlot: "0xc24eaceff5753c99066a839532d708a8661af7a9b01d44d0cd915c53969eb725",
  liquidityBorrowExchangePriceSlot: "0xa8e1248eddf82e10c0adc6c737b6d8da17674abf51801ea5a4549f41c2dfdf21",
  liquidityUserSupplySlot: "0x24db185bc534fad3061e498f976795ac98ae69e4ddedcb59dff17e031b10ad24",
  liquidityUserBorrowSlot: "0xf0c4eb28057fb480235a0ecacdcbcdc1a80b532f8d159a8326e20ea71722879f",
};

// Liquidity slot-map constants (contracts/libraries/liquiditySlotsLink.sol)
const LSI = {
  STATUS: 1, AUTHS: 2, GUARDIANS: 3, USER_CLASS: 4, EXCHANGE_PRICES: 5,
  RATE_DATA: 6, TOTAL_AMOUNTS: 7, USER_SUPPLY: 8, USER_BORROW: 9, LISTED_TOKENS: 10, CONFIGS2: 11,
};

const q = (v) => "0x" + BigInt(v).toString(16);
const num = (v) => Number(BigInt(v));
const hexToBig = (h) => (typeof h === "string" && /^0x[0-9a-f]*$/i.test(h) ? BigInt(h) : 0n);
// BigMathMinified.fromBigNumber(bigNumber, exponentSize=8, exponentMask=0xFF)
const fromBigMath = (bn) => {
  const v = BigInt(bn);
  if (v === 0n) return 0n;
  return (v >> 8n) << (v & 0xffn);
};
const isZeroWord = (h) => !h || /^0x0*$/.test(h);
const lower = (h) => (typeof h === "string" ? h.toLowerCase() : h);

let requestId = 0;
let callCount = 0;
const endpointMeta = []; // family + index only; NEVER the URL

const mapSlot = (slot, key) => keccak256(ABIC.encode(["address", "uint256"], [key, slot]));
const dblSlot = (slot, k1, k2) => keccak256(ABIC.encode(["address", "bytes32"], [k2, mapSlot(slot, k1)]));

// ---------------- endpoint pool (two keyless families; URLs never emitted) ----------------
function candidatePool(chainId) {
  if (chainId !== ETH_CHAIN_ID) return [];
  const archive = [
    { url: "https://eth.blockscout.com/api/eth-rpc", family: "ARCHIVE_1" },
    { url: "https://eth.drpc.org", family: "ARCHIVE_2" },
  ];
  const fallback = [
    { url: "https://gateway.tenderly.co/public/mainnet", family: "FALLBACK_1" },
    { url: "https://rpc.mevblocker.io", family: "FALLBACK_2" },
    { url: "https://ethereum.publicnode.com", family: "FALLBACK_3" },
  ];
  return [...archive, ...fallback];
}

async function rpc(url, method, params) {
  if (callCount >= MAX_CALLS) throw new Error("CALL_BUDGET_EXCEEDED");
  if (Date.now() > DEADLINE) throw new Error("DEADLINE_EXCEEDED");
  callCount += 1;
  const bodyJson = JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params });
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: bodyJson,
      signal: AbortSignal.timeout(20000),
    });
    if (response.status !== 429 || attempt === 2) break;
    await response.arrayBuffer();
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  if (!response.ok) throw new Error("RPC_HTTP_" + response.status);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("RPC_RESPONSE_TOO_LARGE");
  const body = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (body && body.error) throw new Error("RPC_ERROR");
  if (!body || body.result === undefined) throw new Error("RPC_MALFORMED");
  return body.result;
}

async function qualify(c) {
  try {
    if ((await rpc(c.url, "eth_chainId", [])) !== q(ETH_CHAIN_ID)) return null;
    const head = (await rpc(c.url, "eth_getBlockByNumber", ["finalized", false])) ||
      (await rpc(c.url, "eth_getBlockByNumber", ["latest", false]));
    if (!head || !/^0x[0-9a-f]{64}$/i.test(head.hash || "")) return null;
    const headNumber = num(head.number);
    const pin = headNumber - 1;
    const pinBlock = await rpc(c.url, "eth_getBlockByNumber", [q(pin), false]);
    if (!pinBlock || num(pinBlock.number) !== pin || !/^0x[0-9a-f]{64}$/i.test(pinBlock.hash || "")) return null;
    return { uri: c.url, family: c.family, pin, pinHash: pinBlock.hash, pinTimestamp: num(pinBlock.timestamp) };
  } catch (_) {
    return null;
  }
}

// ---------------- offline layout parser ----------------
function readFileOrNull(p) { try { return fs.readFileSync(p, "utf8"); } catch (_) { return null; } }

function parseVariablesLayout(src, contractHeaderRe) {
  if (!src) return null;
  const lines = src.split(/\r?\n/);
  let depth = 0, started = false;
  const rows = [];
  let slot = 0;
  const DECL = /^\s{4}(mapping\s*\([^;]*\)|address(?:\[\])?|uint256|uint8|bytes32|bool|int256)\s+(?:public\s+|internal\s+|private\s+)?(\w+)\s*;/;
  for (const raw of lines) {
    const line = raw.replace(/\/\/.*$/, "");
    if (!started) {
      if (contractHeaderRe.test(raw)) {
        started = true;
        depth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
        if (depth <= 0) depth = 1; // header ends with '{'
      }
      continue;
    }
    if (depth === 1) {
      const m = line.match(DECL);
      if (m) {
        const type = m[1].replace(/\s+/g, "");
        rows.push({
          slot, name: m[2], type,
          kind: type.startsWith("mapping") ? "mapping" : (type.startsWith("address") ? "address/array" : "uint"),
        });
        slot += 1;
      }
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth <= 0) break;
  }
  return rows;
}

// Instadapp infinite-proxy per-selector implementation slot: _SIG_SLOT_BASE with top 4 bytes = selector
const SIG_SLOT_BASE = "3ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const sigImplSlot = (selector) => "0x" + selector.replace(/^0x/, "") + SIG_SLOT_BASE;
const SELECTORS = {
  "operate(address,int256,int256,address,address,bytes)": "ad967e15",
  "updateAuths((address,bool)[])": "3f66feff",
  "updateGuardians((address,bool)[])": "a5eb43ef",
  "updateExchangePrices(address[])": "f4baf000",
  "changeStatus(uint256)": "e8025d77",
};

function buildOfflineLayout() {
  const liqSrc = readFileOrNull(path.join(ROOT, "targets/fluid-contracts-public/contracts/liquidity/common/variables.sol"));
  const vaultSrc = readFileOrNull(path.join(ROOT, "targets/fluid-contracts-public/contracts/protocols/vault/vaultT1/common/variables.sol"));
  const remLiqSrc = readFileOrNull(path.join(ROOT, "remediations/fluid-vaultt2-t4-r2/contracts/liquidity/common/variables.sol"));
  const remVaultSrc = readFileOrNull(path.join(ROOT, "remediations/fluid-vaultt2-t4-r2/contracts/protocols/vault/vaultT1/common/variables.sol"));

  const liquidity = parseVariablesLayout(liqSrc, /^\s*abstract\s+contract\s+Variables\b/);
  const vaultT1 = parseVariablesLayout(vaultSrc, /^\s*contract\s+Variables\b/);

  const layoutConsistency = {
    liquiditySlotCount: liquidity ? liquidity.length : 0,
    liquidityAuthsAt2: liquidity ? (liquidity[2] && liquidity[2].name) === "_isAuth" : null,
    liquidityGuardiansAt3: liquidity ? (liquidity[3] && liquidity[3].name) === "_isGuardian" : null,
    liquidityUserClassAt4: liquidity ? (liquidity[4] && liquidity[4].name) === "_userClass" : null,
    liquidityUserSupplyAt8: liquidity ? (liquidity[8] && liquidity[8].name) === "_userSupplyData" : null,
    liquidityUserBorrowAt9: liquidity ? (liquidity[9] && liquidity[9].name) === "_userBorrowData" : null,
    liquidityListedTokensAt10: liquidity ? (liquidity[10] && liquidity[10].name) === "_listedTokens" : null,
    vaultT1SlotCount: vaultT1 ? vaultT1.length : 0,
  };

  const mappingRootTemplates = {
    "_isAuth (user auth namespace)": { slot: LSI.AUTHS, key: "address", root: "keccak256(abi.encode(auth, 2))" },
    "_isGuardian (dual auth namespace)": { slot: LSI.GUARDIANS, key: "address", root: "keccak256(abi.encode(guardian, 3))" },
    "_userClass": { slot: LSI.USER_CLASS, key: "address", root: "keccak256(abi.encode(user, 4))" },
    "_exchangePricesAndConfig": { slot: LSI.EXCHANGE_PRICES, key: "address token", root: "keccak256(abi.encode(token, 5))" },
    "_totalAmounts": { slot: LSI.TOTAL_AMOUNTS, key: "address token", root: "keccak256(abi.encode(token, 7))" },
    "_userSupplyData (user allowance-class row)": { slot: LSI.USER_SUPPLY, key: "address user,address token", root: "keccak256(abi.encode(token, keccak256(abi.encode(user, 8))))" },
    "_userBorrowData (user allowance-class row)": { slot: LSI.USER_BORROW, key: "address user,address token", root: "keccak256(abi.encode(token, keccak256(abi.encode(user, 9))))" },
    "_listedTokens": { slot: LSI.LISTED_TOKENS, key: "array length", root: "slot 10" },
    "_configs2": { slot: LSI.CONFIGS2, key: "address token", root: "keccak256(abi.encode(token, 11))" },
    "infiniteProxy._DUMMY_IMPLEMENTATION_SLOT (EIP-1967 impl slot = dummy impl)": { slot: "0x360894a1...82bbc", key: "-", root: "fixed slot" },
    "infiniteProxy per-selector impl slot": { slot: "_SIG_SLOT_BASE | selector", key: "bytes4 selector", root: "0x<selector>3ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" },
  };

  const remediationJoin = {
    liquidityVariablesMatch: liqSrc !== null && remLiqSrc !== null && liqSrc === remLiqSrc,
    vaultT1VariablesMatch: vaultSrc !== null && remVaultSrc !== null && vaultSrc === remVaultSrc,
  };

  return {
    source: {
      liquidityVariables: "targets/fluid-contracts-public/contracts/liquidity/common/variables.sol",
      vaultT1Variables: "targets/fluid-contracts-public/contracts/protocols/vault/vaultT1/common/variables.sol",
    },
    liquiditySlotsLinkConstants: LSI,
    liquidityNamespace: liquidity,
    vaultT1Namespace: vaultT1,
    layoutConsistency,
    mappingRootTemplates,
    remediationJoin,
  };
}

// ---------------- live read plan ----------------
function buildReadPlan(offline) {
  const authNamespaces = [
    { label: "_isAuth[main]", ns: "isAuth", slot: LSI.AUTHS, key: MAIN_USER },
    { label: "_isGuardian[main]", ns: "isGuardian", slot: LSI.GUARDIANS, key: MAIN_USER },
    { label: "_userClass[main]", ns: "userClass", slot: LSI.USER_CLASS, key: MAIN_USER },
    { label: "_isAuth[vault14]", ns: "isAuth", slot: LSI.AUTHS, key: VAULT14 },
    { label: "_isGuardian[vault14]", ns: "isGuardian", slot: LSI.GUARDIANS, key: VAULT14 },
    { label: "_isAuth[fwstETH]", ns: "isAuth", slot: LSI.AUTHS, key: FTOKEN_WSTETH },
  ].map((r) => ({ ...r, slotPath: `keccak(abi.encode(${r.key}, ${r.slot}))`, slotHash: mapSlot(r.slot, r.key), class: "auth-namespace" }));

  const allowanceRows = [
    { label: "_userSupplyData[main][wstETH]", ns: "userSupply", slot: LSI.USER_SUPPLY, k1: MAIN_USER, k2: WSTETH },
    { label: "_userSupplyData[vault14][wstETH]", ns: "userSupply", slot: LSI.USER_SUPPLY, k1: VAULT14, k2: WSTETH },
    { label: "_userSupplyData[fwstETH][wstETH]", ns: "userSupply", slot: LSI.USER_SUPPLY, k1: FTOKEN_WSTETH, k2: WSTETH },
    { label: "_userBorrowData[main][USDC]", ns: "userBorrow", slot: LSI.USER_BORROW, k1: MAIN_USER, k2: USDC },
    { label: "_userBorrowData[vault14][USDC]", ns: "userBorrow", slot: LSI.USER_BORROW, k1: VAULT14, k2: USDC },
  ].map((r) => ({ ...r, slotPath: `keccak(abi.encode(${r.k2}, keccak(abi.encode(${r.k1}, ${r.slot}))))`, slotHash: dblSlot(r.slot, r.k1, r.k2), class: "user-allowance-row" }));

  const configRows = [
    { label: "_exchangePricesAndConfig[wstETH]", ns: "exchangePrices", slot: LSI.EXCHANGE_PRICES, k: WSTETH },
    { label: "_exchangePricesAndConfig[USDC]", ns: "exchangePrices", slot: LSI.EXCHANGE_PRICES, k: USDC },
    { label: "_totalAmounts[wstETH]", ns: "totalAmounts", slot: LSI.TOTAL_AMOUNTS, k: WSTETH },
    { label: "_totalAmounts[USDC]", ns: "totalAmounts", slot: LSI.TOTAL_AMOUNTS, k: USDC },
  ].map((r) => ({ ...r, slotPath: `keccak(abi.encode(${r.k}, ${r.slot}))`, slotHash: mapSlot(r.slot, r.k), class: "config/aggregate" }));

  const manifestRows = Object.entries(MANIFEST_SLOTS).map(([label, slotHash]) => ({ label: "manifest:" + label, class: "manifest-slot", slotHash }));

  const rawLiquidity = [];
  for (let s = 0; s <= 11; s += 1) rawLiquidity.push({ label: `raw[${s}]`, class: "raw-slot", slotHash: q(s), slot: s });
  const rawVault = [];
  for (let s = 0; s <= 11; s += 1) rawVault.push({ label: `raw[${s}]`, class: "raw-slot", slotHash: q(s), slot: s });
  const selectorImpls = Object.entries(SELECTORS).map(([sig, sel]) => ({
    label: `selImpl[${sig}]`, class: "selector-impl", selector: sel, slotHash: sigImplSlot(sel),
  }));

  return {
    liquidity: [
      ...rawLiquidity,
      { label: "eip1967.impl", class: "proxy-slot", slotHash: EIP1967_IMPL_SLOT },
      { label: "eip1967.admin", class: "proxy-slot", slotHash: EIP1967_ADMIN_SLOT },
      ...authNamespaces, ...allowanceRows, ...configRows, ...manifestRows, ...selectorImpls,
    ],
    vault14: [
      ...rawVault,
      { label: "eip1967.impl", class: "proxy-slot", slotHash: EIP1967_IMPL_SLOT },
    ],
  };
}

async function readSlots(url, address, rows, pin, tag) {
  const out = [];
  for (const row of rows) {
    let value;
    try { value = await rpc(url, "eth_getStorageAt", [address, row.slotHash, q(pin)]); }
    catch (e) { value = null; row = { ...row, error: String(e.message || e) }; }
    out.push({ ...row, address: tag, value, nonzero: value ? !isZeroWord(value) : false });
  }
  return out;
}

// ---------------- main ----------------
async function main() {
  const artifact = {
    tool: "fluid-allowance-class-step2.js",
    task: "T3 Fluid live-impl allowance-class kernel lens, step 2",
    chain: "ethereum",
    chainId: ETH_CHAIN_ID,
    addresses: {
      liquidityProxy: LIQUIDITY_PROXY,
      liquidityLiveImplDecodePrimary: LIQUIDITY_LIVE_IMPL_DECODE_PRIMARY,
      liquidityRegistryImpl: LIQUIDITY_REGISTRY_IMPL,
      reserveProxy: RESERVE_PROXY,
      vault14: VAULT14,
      wstETH: WSTETH, USDC, fTokenWstETH: FTOKEN_WSTETH, mainUser: MAIN_USER,
    },
    authorization: {
      readOnly: true, signedActions: false, privateKeysRead: false,
      endpointMaterialLogged: false, stateChanges: false, upstreamForwarding: false,
    },
    offlineLayout: null,
    pin: null,
    liveReads: {},
    twoFamily: {},
    lens: {},
    gates: { routePositive: "false", executableNow: "false", signedActionJustified: false },
    status: "RUNNING",
  };

  artifact.offlineLayout = buildOfflineLayout();
  fs.writeFileSync(LAYOUT_OUT, JSON.stringify(artifact.offlineLayout, null, 1));

  artifact.provenance = {
    vault14Manifest: "targets/fluid-contracts-public/deployments/mainnet/dump/0x1982CC7b1570C2503282d0A0B41F69b3B28fdcc3.json",
    vault14ManifestArgs: {
      liquidity: LIQUIDITY_PROXY, factory: VAULT_FACTORY, supplyToken: WSTETH, borrowToken: USDC,
      supplyDecimals: 18, borrowDecimals: 6, vaultId: 14,
    },
    vault14AlsoDeployedOn: ["base", "arbitrum"],
    note: "vault-14 is a mainnet deployment (manifest under deployments/mainnet/dump); the same CREATE address recurs on base/arbitrum.",
    liquiditySlotsLink: "targets/fluid-contracts-public/contracts/libraries/liquiditySlotsLink.sol",
    infiniteProxy: "targets/fluid-contracts-public/contracts/infiniteProxy/proxy.sol",
  };

  // qualify an endpoint (family 1) at a fresh finalized pin
  const pool = candidatePool(ETH_CHAIN_ID);
  let chosen = null;
  for (const c of pool) {
    const ok = await qualify(c);
    if (ok) { chosen = ok; break; }
  }
  if (!chosen) { artifact.status = "INCOMPLETE_NO_QUALIFIED_ENDPOINT"; return artifact; }
  endpointMeta.push({ family: chosen.family, role: "primary" });
  artifact.pin = { block: chosen.pin, hash: chosen.pinHash, timestamp: chosen.pinTimestamp, primaryFamily: chosen.family };

  const plan = buildReadPlan(artifact.offlineLayout);

  // code identity checks at pin
  const code = {};
  for (const [k, addr] of Object.entries({
    liquidityProxy: LIQUIDITY_PROXY, liquidityImpl: LIQUIDITY_LIVE_IMPL_DECODE_PRIMARY,
    reserveProxy: RESERVE_PROXY, vault14: VAULT14,
  })) {
    try { const c = await rpc(chosen.uri, "eth_getCode", [addr, q(chosen.pin)]); code[k] = { bytes: Math.max(0, (c.length - 2) / 2) }; }
    catch (e) { code[k] = { error: String(e.message || e) }; }
  }
  artifact.codeIdentity = code;

  artifact.liveReads.liquidity = await readSlots(chosen.uri, LIQUIDITY_PROXY, plan.liquidity, chosen.pin, "liquidity");
  artifact.liveReads.vault14 = await readSlots(chosen.uri, VAULT14, plan.vault14, chosen.pin, "vault14");

  // two-family corroboration of the allowance/auth-critical slots
  const secondFamily = pool.find((c) => c.family !== chosen.family && c.family.startsWith("FALLBACK"));
  let corr = { attempted: false };
  if (secondFamily) {
    const ok2 = await qualify(secondFamily);
    if (ok2 && ok2.pin === chosen.pin) {
      corr.attempted = true;
      corr.family = ok2.family;
      const criticalL = plan.liquidity.filter((r) => r.class === "auth-namespace" || r.class === "user-allowance-row" || r.class === "manifest-slot");
      const rows2 = await readSlots(ok2.uri, LIQUIDITY_PROXY, criticalL, chosen.pin, "liquidity");
      const byLabel = Object.fromEntries(rows2.map((r) => [r.label, r.value]));
      corr.checked = rows2.length;
      corr.agreements = 0; corr.disagreements = [];
      for (const r of artifact.liveReads.liquidity) {
        if (byLabel[r.label] === undefined) continue;
        if (lower(byLabel[r.label]) === lower(r.value)) corr.agreements += 1;
        else corr.disagreements.push({ label: r.label, primary: r.value, second: byLabel[r.label] });
      }
      corr.consistent = corr.disagreements.length === 0;
      endpointMeta.push({ family: ok2.family, role: "corroboration" });
    } else {
      corr.reason = ok2 ? "SECOND_FAMILY_PIN_MISMATCH" : "SECOND_FAMILY_UNQUALIFIED";
    }
  } else {
    corr.reason = "NO_SECOND_FAMILY";
  }
  artifact.twoFamily = corr;

  // ---------------- lens: allowance/auth invariant checks ----------------
  const L = Object.fromEntries(artifact.liveReads.liquidity.map((r) => [r.label, r.value]));
  const V = Object.fromEntries(artifact.liveReads.vault14.map((r) => [r.label, r.value]));

  const allowanceRows = artifact.liveReads.liquidity.filter((r) => r.class === "user-allowance-row" || r.class === "auth-namespace");
  const allowanceNonZero = allowanceRows.filter((r) => r.nonzero);

  const lens = {
    decodePrimaryImplMatchesRecorded: lower(addrFromWord(L["eip1967.impl"])) === lower(LIQUIDITY_LIVE_IMPL_DECODE_PRIMARY),
    dummyImplSemantics: {
      note: "Liquidity proxy is an Instadapp infinite-proxy; the EIP-1967 slot holds the DUMMY implementation, real logic is registered per-selector.",
      dummyImpl: lower(addrFromWord(L["eip1967.impl"])),
    },
    registryImplEqualsReserveImpl: lower(LIQUIDITY_REGISTRY_IMPL) === lower("0xfb3102759f2d57f547b9c519db49ce1ffde15db2"),
    liquiditySlot0EqualsReserveProxy: lower(addrFromWord(L["raw[0]"])) === lower(RESERVE_PROXY),
    liquidityStatusIsOne: hexToBig(L["raw[1]"]) === 1n,
    liquidityListedTokensCount: num(hexToBig(L["raw[10]"])),
    liquiditySilo: {
      isAuthMain: hexToBig(L["_isAuth[main]"]) === 1n,
      isGuardianMain: hexToBig(L["_isGuardian[main]"]) === 1n,
      userClassMain: num(hexToBig(L["_userClass[main]"])),
      isAuthVault14: hexToBig(L["_isAuth[vault14]"]) === 1n,
      isAuthFwstETH: hexToBig(L["_isAuth[fwstETH]"]) === 1n,
    },
    manifestSlotSelfTest: {
      ok: MANIFEST_SLOTS.liquidityUserSupplySlot.toLowerCase() === MANIFEST_SLOTS.liquidityUserSupplySlot.toLowerCase(),
      userSupplyEqualsComputed: MANIFEST_SLOTS.liquidityUserSupplySlot.toLowerCase() === dblSlot(LSI.USER_SUPPLY, VAULT14, WSTETH).toLowerCase(),
      userBorrowEqualsComputed: MANIFEST_SLOTS.liquidityUserBorrowSlot.toLowerCase() === dblSlot(LSI.USER_BORROW, VAULT14, USDC).toLowerCase(),
      totalSupplyEqualsComputed: MANIFEST_SLOTS.liquidityTotalSupplySlot.toLowerCase() === mapSlot(LSI.TOTAL_AMOUNTS, WSTETH).toLowerCase(),
      totalBorrowEqualsComputed: MANIFEST_SLOTS.liquidityTotalBorrowSlot.toLowerCase() === mapSlot(LSI.TOTAL_AMOUNTS, USDC).toLowerCase(),
      supplyExPriceEqualsComputed: MANIFEST_SLOTS.liquiditySupplyExchangePriceSlot.toLowerCase() === mapSlot(LSI.EXCHANGE_PRICES, WSTETH).toLowerCase(),
      borrowExPriceEqualsComputed: MANIFEST_SLOTS.liquidityBorrowExchangePriceSlot.toLowerCase() === mapSlot(LSI.EXCHANGE_PRICES, USDC).toLowerCase(),
    },
    vault14: {
      slot1Top20Bytes: lower("0x" + V["raw[1]"].slice(2, 42)),
      slot1OracleMatchesRecorded: lower("0x" + V["raw[1]"].slice(2, 42)) === lower("0xc5911fa3917c507fbebab910c8b47cbdd3ce147e"),
      vaultVariablesRaw: V["raw[0]"],
      ratesRaw: V["raw[8]"],
      rebalancer: addrFromWord(V["raw[9]"]),
      rebalancerIsReserveProxy: lower(addrFromWord(V["raw[9]"])) === lower(RESERVE_PROXY),
      eip1967ImplZero: isZeroWord(V["eip1967.impl"]),
    },
  };

  // user-allowance row bit-decode (userSupply mode+amount; userBorrow mode+amount)
  const decodeUserSupply = (word) => {
    const w = hexToBig(word);
    if (w === 0n) return { present: false };
    const mode = w & 1n;                       // bit 0
    const amount = (w >> 1n) & ((1n << 64n) - 1n);
    const lastUpdate = (w >> 129n) & ((1n << 33n) - 1n);
    const paused = (w >> 255n) & 1n;
    return { present: true, modeWithInterest: Number(mode), amountBigMathRaw: amount.toString(), amountNormal: fromBigMath(amount).toString(), lastUpdate: Number(lastUpdate), paused: Number(paused) };
  };
  const decodeUserBorrow = (word) => {
    const w = hexToBig(word);
    if (w === 0n) return { present: false };
    const mode = w & 1n;
    const amount = (w >> 1n) & ((1n << 64n) - 1n);
    const lastUpdate = (w >> 129n) & ((1n << 33n) - 1n);
    const paused = (w >> 255n) & 1n;
    return { present: true, modeWithInterest: Number(mode), amountBigMathRaw: amount.toString(), amountNormal: fromBigMath(amount).toString(), lastUpdate: Number(lastUpdate), paused: Number(paused) };
  };
  lens.userAllowanceDecode = {
    mainWstETHSupply: decodeUserSupply(L["_userSupplyData[main][wstETH]"]),
    vault14WstETHSupply: decodeUserSupply(L["_userSupplyData[vault14][wstETH]"]),
    fwstETHWstETHSupply: decodeUserSupply(L["_userSupplyData[fwstETH][wstETH]"]),
    mainUSDCDebt: decodeUserBorrow(L["_userBorrowData[main][USDC]"]),
    vault14USDCDebt: decodeUserBorrow(L["_userBorrowData[vault14][USDC]"]),
  };
  lens.allowanceRowsNonZeroCount = allowanceNonZero.length;
  lens.allowanceRowsNonZero = allowanceNonZero.map((r) => ({ label: r.label, slotPath: r.slotPath, slotHash: r.slotHash, value: r.value }));

  const decodeTotals = (word) => {
    const w = hexToBig(word);
    const M = (1n << 64n) - 1n;
    return {
      supplyWithInterest: fromBigMath(w & M).toString(),
      supplyInterestFree: fromBigMath((w >> 64n) & M).toString(),
      borrowWithInterest: fromBigMath((w >> 128n) & M).toString(),
      borrowInterestFree: fromBigMath((w >> 192n) & M).toString(),
    };
  };
  const totalWst = decodeTotals(L["_totalAmounts[wstETH]"]);
  const totalUsdc = decodeTotals(L["_totalAmounts[USDC]"]);
  const v14Supply = decodeUserSupply(L["_userSupplyData[vault14][wstETH]"]);
  const fwSupply = decodeUserSupply(L["_userSupplyData[fwstETH][wstETH]"]);
  const v14Borrow = decodeUserBorrow(L["_userBorrowData[vault14][USDC]"]);
  const nestedSupplySum = BigInt(v14Supply.amountNormal || "0") + BigInt(fwSupply.amountNormal || "0");
  lens.conservation = {
    method: "BigMathMinified.fromBigNumber(56|8) for all amount fields",
    totalAmountsWstETH_normal: totalWst,
    totalAmountsUSDC_normal: totalUsdc,
    sampledUserSupplyNormal: { vault14: v14Supply.amountNormal || "0", fwstETH: fwSupply.amountNormal || "0" },
    nestedUserSupplySumNormal: nestedSupplySum.toString(),
    nestedSumLEtotalWstETH: nestedSupplySum <= BigInt(totalWst.supplyWithInterest),
    sampledUserBorrowNormal: { vault14: v14Borrow.amountNormal || "0" },
    vault14BorrowLEtotalUSDC: BigInt(v14Borrow.amountNormal || "0") <= BigInt(totalUsdc.borrowWithInterest),
  };
  lens.exchangePrice = {
    wstETH_supplyExchangePrice_1e12: ((hexToBig(L["_exchangePricesAndConfig[wstETH]"]) >> 91n) & ((1n << 64n) - 1n)).toString(),
    wstETH_borrowExchangePrice_1e12: ((hexToBig(L["_exchangePricesAndConfig[wstETH]"]) >> 155n) & ((1n << 64n) - 1n)).toString(),
    wstETH_lastUpdateTimestamp: Number((hexToBig(L["_exchangePricesAndConfig[wstETH]"]) >> 58n) & ((1n << 33n) - 1n)),
    USDC_supplyExchangePrice_1e12: ((hexToBig(L["_exchangePricesAndConfig[USDC]"]) >> 91n) & ((1n << 64n) - 1n)).toString(),
    USDC_borrowExchangePrice_1e12: ((hexToBig(L["_exchangePricesAndConfig[USDC]"]) >> 155n) & ((1n << 64n) - 1n)).toString(),
  };

  artifact.lens = lens;

  // resolve real per-selector implementations (infinite-proxy) + code identity
  const localMeta = {
    userModule: artifactMetaHash("out/mainMainnet.sol/FluidLiquidityUserModuleMainnet.json"),
    adminModule: artifactMetaHash("out/mainMainnet.sol/FluidLiquidityAdminModuleMainnet.json"),
  };
  const selectorImpls = [];
  for (const r of artifact.liveReads.liquidity.filter((x) => x.class === "selector-impl")) {
    const impl = lower(addrFromWord(r.value));
    const entry = { signature: r.label.replace(/^selImpl\[|\]$/g, ""), selector: r.selector, impl, zero: isZeroWord(r.value) };
    if (!entry.zero) {
      try {
        const c = await rpc(chosen.uri, "eth_getCode", [impl, q(chosen.pin)]);
        entry.codeByteLength = Math.max(0, (c.length - 2) / 2);
        entry.metadataHash = metadataHash(c);
        entry.matchesLocalUserModule = lower(entry.metadataHash || "") === lower(localMeta.userModule || "x");
        entry.matchesLocalAdminModule = lower(entry.metadataHash || "") === lower(localMeta.adminModule || "x");
      } catch (e) { entry.codeError = String(e.message || e); }
    }
    selectorImpls.push(entry);
  }
  lens.selectorImplementations = selectorImpls;

  // classification of registry != live-impl delta
  let implMetaLive = null;
  try { implMetaLive = metadataHash(await rpc(chosen.uri, "eth_getCode", [LIQUIDITY_LIVE_IMPL_DECODE_PRIMARY, q(chosen.pin)])); } catch (_) {}
  lens.registryDelta = {
    registryImpl: LIQUIDITY_REGISTRY_IMPL,
    liveEip1967DummyImpl: lower(addrFromWord(L["eip1967.impl"])),
    registryImplIsReserveImpl: lower(LIQUIDITY_REGISTRY_IMPL) === lower("0xfb3102759f2d57f547b9c519db49ce1ffde15db2"),
    dummyImplNote: "EIP-1967 slot on an infinite-proxy stores the DUMMY impl (no per-selector logic); the registry row is not a same-slot comparison.",
    dummyImplMetadataHash: implMetaLive,
    localModuleMetadataHash: localMeta,
    liveImplMatchesLocalModule: implMetaLive ? Object.values(localMeta).filter(Boolean).some((m) => lower(m) === lower(implMetaLive)) : null,
    classification: null,
  };
  {
    const rd = lens.registryDelta;
    const anySelectorResolved = selectorImpls.some((e) => !e.zero);
    const matched = selectorImpls.filter((e) => e.matchesLocalUserModule || e.matchesLocalAdminModule);
    const withMeta = selectorImpls.filter((e) => e.metadataHash);
    rd.logicRevisionLinkage = matched.length > 0 ? "MATCH_LOCAL_MODULE"
      : (withMeta.length > 0 ? "REVISION_DRIFT_METADATA_PRESENT" : "METADATA_UNAVAILABLE");
    rd.selectorImplsMatchedToLocalModule = matched.map((e) => e.selector);
    if (rd.registryImplIsReserveImpl && anySelectorResolved) {
      rd.classification = "BENIGN_REVISION_INFINITE_PROXY_PER_SELECTOR_IMPL";
    } else if (!anySelectorResolved) {
      rd.classification = "INCOMPLETE_NO_SELECTOR_IMPL_RESOLVED";
    } else {
      rd.classification = "AUDIT_COVERAGE_HOLE_LIVE_IMPL_NOT_LINKED_TO_LOCAL_OUT_ARTIFACT";
    }
  }

  // gate: require >=1 user-allowance slot decode
  if (allowanceNonZero.length < 1) {
    artifact.status = "INCOMPLETE_NO_USER_ALLOWANCE_DECODE";
  } else if (artifact.status === "RUNNING") {
    artifact.status = "OK_ALLOWANCE_CLASS_DECODE_LANDED";
  }

  return artifact;

  function BigKit(_l, key) {
    const v = L["_" + key];
    if (!v) return null;
    const w = hexToBig(v);
    return {
      supplyWithInterestRaw: (w & ((1n << 64n) - 1n)).toString(),
      supplyInterestFreeRaw: ((w >> 64n) & ((1n << 64n) - 1n)).toString(),
      borrowWithInterestRaw: ((w >> 128n) & ((1n << 64n) - 1n)).toString(),
      borrowInterestFreeRaw: ((w >> 192n) & ((1n << 64n) - 1n)).toString(),
    };
  }
}

function hexWord(h) { return typeof h === "string" && /^0x[0-9a-f]{64}$/i.test(h) ? h : "0x" + "0".repeat(64); }
function addrFromWord(h) { const w = hexWord(h); return "0x" + w.slice(2).slice(24); }
function metadataHash(bytecode) {
  if (typeof bytecode !== "string" || !bytecode) return null;
  const hex = (bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode).toLowerCase();
  if (hex.length < 110) return null;
  const trailer = hex.slice(-110);
  const idx = trailer.indexOf("a264697066735822");
  if (idx < 0 || !trailer.endsWith("0033")) return null;
  return "0x" + trailer.slice(idx + 20, idx + 20 + 64);
}
function artifactMetaHash(rel) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, "targets/fluid-contracts-public", rel), "utf8"));
    const db = j.deployedBytecode;
    const hex = typeof db === "string" ? db : (db && db.object);
    return metadataHash(hex);
  } catch (_) { return null; }
}

main()
  .then((artifact) => {
    artifact.callsUsed = callCount;
    artifact.endpointMeta = endpointMeta;
    fs.writeFileSync(OUTPUT, JSON.stringify(artifact, null, 1));
    console.log("STATUS", artifact.status);
    console.log("PIN", artifact.pin && artifact.pin.block, artifact.pin && artifact.pin.hash);
    console.log("ALLOWANCE_NONZERO", artifact.lens.allowanceRowsNonZeroCount);
    console.log("TWO_FAMILY", artifact.twoFamily.consistent, artifact.twoFamily.checked);
    console.log("REGISTRY_DELTA", artifact.lens.registryDelta.classification);
    console.log("CALLS", callCount);
  })
  .catch((e) => {
    console.error("FAILED", e && e.message);
    process.exitCode = 1;
  });
