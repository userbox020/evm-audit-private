#!/usr/bin/env node
"use strict";
/*
 * Read-only, bounded slot/getter capture for the docs-era Symbiotic Rewards TUP proxy.
 * ETH mainnet, view-only methods. Endpoint URLs are never printed.
 * Outputs reports/raw/fast/critical-symbiotic-step1-rewardsproxy-slots.json
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { id } = require("ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc.js");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "reports", "raw", "fast", "critical-symbiotic-step1-rewardsproxy-slots.json");
const PROXY = "0xa13e65cA0FeFa52cCb9615108fF400EF4806866B";
const ALLOWED_METHODS = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call"]);

const SLOTS = Object.freeze({
  ERC1967_IMPL: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  ERC1967_ADMIN: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  ERC1967_BEACON: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
});

// EIP-7201: keccak256(abi.encode(uint256(keccak256(namespace)) - 1)) & ~0xff
function erc7201(namespace) {
  const h = BigInt(id(namespace)) - 1n;
  const word = BigInt(id("0x" + h.toString(16).padStart(64, "0")));
  const masked = word & ~0xffn;
  return "0x" + masked.toString(16).padStart(64, "0");
}

const NAMESPACES = Object.freeze({
  ProtocolFees: erc7201("symbiotic.rewards.ProtocolFees"),
  VaultSnapshotRewards: erc7201("symbiotic.rewards.VaultSnapshotRewards"),
  CumulativeMerkleRewards: erc7201("symbiotic.rewards.CumulativeMerkleRewards"),
});

function selector(sig) {
  return id(sig).slice(0, 10);
}
const GETTERS = Object.freeze({
  VAULT_FACTORY: "VAULT_FACTORY()",
  NETWORK_REGISTRY: "NETWORK_REGISTRY()",
  NETWORK_MIDDLEWARE_SERVICE: "NETWORK_MIDDLEWARE_SERVICE()",
  CURATOR_REGISTRY: "CURATOR_REGISTRY()",
  FEE_REGISTRY: "FEE_REGISTRY()",
  MAX_FEE: "MAX_FEE()",
  owner: "owner()",
});

function sha256(hex) {
  return "0x" + crypto.createHash("sha256").update(Buffer.from(hex.slice(2), "hex")).digest("hex");
}
function wordIndex(base, i) {
  return "0x" + (BigInt(base) + BigInt(i)).toString(16).padStart(64, "0");
}
function decodeAddress(word) {
  const w = word.padStart(66, "0").slice(2);
  return "0x" + w.slice(24).toLowerCase();
}
function isZero(word) {
  return !word || /^0x0*$/.test(word);
}

async function main() {
  const endpoint = await resolveRpc(1, null, { maxCandidates: 8 });
  if (!endpoint) throw new Error("no-mainnet-endpoint");
  const chainId = await rpcCall(endpoint, "eth_chainId", []);
  if (chainId !== "0x1") throw new Error("wrong-chain");
  const block = await rpcCall(endpoint, "eth_getBlockByNumber", ["latest", false]);
  if (!block || !block.number) throw new Error("no-block");
  const blockSelector = block.number;
  const out = {
    schema: "critical-symbiotic-step1-rewardsproxy-slots/v1",
    chainId: "1",
    observedAt: new Date().toISOString(),
    block: { number: block.number, hash: block.hash, timestamp: block.timestamp },
    proxy: PROXY,
    methods: [...ALLOWED_METHODS],
    proxyRuntime: null,
    slots: {},
    getters: {},
    implementation: {},
    rawStorage0to3: {},
  };

  const code = await rpcCall(endpoint, "eth_getCode", [PROXY, blockSelector]);
  out.proxyRuntime = { present: typeof code === "string" && code.length > 2, bytes: (code.length - 2) / 2, sha256: sha256(code) };

  const slotReads = { ...SLOTS, ...NAMESPACES };
  for (const [name, slot] of Object.entries(slotReads)) {
    const value = await rpcCall(endpoint, "eth_getStorageAt", [PROXY, slot, blockSelector]);
    out.slots[name] = { slot, value, address: decodeAddress(value), zero: isZero(value) };
  }
  for (let i = 0; i < 4; i++) {
    const slot = wordIndex("0x0", i);
    const value = await rpcCall(endpoint, "eth_getStorageAt", [PROXY, slot, blockSelector]);
    out.rawStorage0to3["slot" + i] = { value, address: decodeAddress(value), zero: isZero(value) };
  }

  // ERC-7201 namespace first words (struct head) to confirm impl-family state is present.
  for (const [ns, base] of Object.entries(NAMESPACES)) {
    out.slots[ns + "_word0"] = { slot: wordIndex(base, 0), value: await rpcCall(endpoint, "eth_getStorageAt", [PROXY, wordIndex(base, 0), blockSelector]) };
    out.slots[ns + "_word1"] = { slot: wordIndex(base, 1), value: await rpcCall(endpoint, "eth_getStorageAt", [PROXY, wordIndex(base, 1), blockSelector]) };
  }

  for (const [name, sig] of Object.entries(GETTERS)) {
    const data = selector(sig);
    const result = await rpcCall(endpoint, "eth_call", [{ to: PROXY, data }, blockSelector]);
    out.getters[name] = { signature: sig, selector: data, result, ok: typeof result === "string" && result.length >= 3 };
  }

  const impl = out.slots.ERC1967_IMPL.address;
  if (!out.slots.ERC1967_IMPL.zero) {
    const implCode = await rpcCall(endpoint, "eth_getCode", [impl, blockSelector]);
    out.implementation = {
      address: impl,
      runtime: { present: typeof implCode === "string" && implCode.length > 2, bytes: (implCode.length - 2) / 2, sha256: sha256(implCode) },
    };
    const implGetters = {};
    for (const [name, sig] of Object.entries(GETTERS)) {
      implGetters[name] = await rpcCall(endpoint, "eth_call", [{ to: impl, data: selector(sig) }, blockSelector]);
    }
    out.implementation.getters = implGetters;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  // Sanitized summary (no URLs).
  console.log("CHAIN=" + out.chainId + " BLOCK=" + out.block.number);
  console.log("PROXY_RUNTIME bytes=" + out.proxyRuntime.bytes + " sha256=" + out.proxyRuntime.sha256);
  console.log("IMPL_SLOT=" + out.slots.ERC1967_IMPL.value);
  console.log("ADMIN_SLOT=" + out.slots.ERC1967_ADMIN.value);
  console.log("BEACON_SLOT=" + out.slots.ERC1967_BEACON.value);
  console.log("ADMIN_ADDR=" + out.slots.ERC1967_ADMIN.address);
  console.log("IMPL_ADDR=" + out.slots.ERC1967_IMPL.address);
  for (const [name, g] of Object.entries(out.getters)) {
    console.log("GETTER " + name + "=" + (g.ok ? g.result : "NA") + " (via proxy)");
  }
  if (out.implementation.address) {
    console.log("IMPL_RUNTIME bytes=" + out.implementation.runtime.bytes + " sha256=" + out.implementation.runtime.sha256);
    for (const [name, v] of Object.entries(out.implementation.getters)) console.log("IMPL_GETTER " + name + "=" + (v || "NA"));
  }
  for (const [ns, base] of Object.entries(NAMESPACES)) {
    console.log("NS " + ns + " base=" + base + " w0=" + out.slots[ns + "_word0"].value);
  }
  console.log("OUT=" + path.relative(ROOT, OUT));
}

main().catch((e) => { console.error("FAIL " + e.message); process.exit(1); });
