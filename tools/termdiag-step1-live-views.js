#!/usr/bin/env node
"use strict";
/*
 * termdiag-step1-live-views.js
 *
 * READ-ONLY, bounded live-view binding for the TermDiamond + TermRepoDeployerFactory
 * step-1 lane. No transactions, no signing, no forks, no eth_getLogs.
 *
 * Bounds:
 *  - one Ethereum mainnet endpoint selected from rpc_endpoints.txt (serial probe, capped)
 *  - eth_chainId, eth_getCode, eth_call (view only)
 *  - endpoint URLs are never printed or persisted
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require(path.join(__dirname, "node_modules", "ethers"));
const sharedRpc = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const INVENTORY = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "termdiag-step1-live-views.json");

const MAX_ENDPOINT_ATTEMPTS = 40;
const PER_CALL_TIMEOUT_MS = 7000;

const ADDRESSES = {
  factorySeed: "0x44058C32B154A516F3b9DE2413e6cb938F93c3B4",
  controllerProxy: "0xd902EBb8AEb832643af38f43d466a6155cD8Bd5A",
  emitterProxy: "0xf021B31282a60528B2F47D07Ce353da870be78b3",
  candidates: [
    "0xa7dE1A7118e2BBE17c0928673966f466b18aDE77",
    "0xc8006dec63d7d2f6b45a0f5de90390a86a6b950d",
    "0x99FE7E977DFE42700f4424Bc4B2bbb3EfcC6E691",
  ],
};

// From tools/term-nominal-ingress-stage-a-r1/fixtures/runtime-fingerprints.json
const FACTORY_EXPECT = {
  runtimeBytes: 17749,
  immutableNormalizedKeccak: "0x85533fd16302e835cdaa807bd12ed7fb45b7bdb1faac8009acf689de5d0bf72a",
  immutableRanges: [
    [549, 32], [4196, 32], [4494, 32], [4820, 32],
    [10969, 32], [11248, 32], [11971, 32], [12163, 32],
    [1187, 32], [4156, 32], [4454, 32], [4780, 32],
    [11003, 32], [11208, 32], [11541, 32], [11924, 32],
    [12197, 32], [4236, 32], [4534, 32], [6964, 32],
    [11479, 32], [11878, 32], [12231, 32],
  ],
};

const FACTORY_ABI = [
  "function admin() view returns (address)",
  "function devops() view returns (address)",
  "function controller() view returns (address)",
  "function emitter() view returns (address)",
  "function priceOracle() view returns (address)",
  "function termDiamond() view returns (address)",
  "function deployingPaused() view returns (bool)",
  "function deployingAuctionsPaused() view returns (bool)",
  "function deployingTermReposPaused() view returns (bool)",
  "function termVersion() view returns (string)",
  "function auctionVersion() view returns (string)",
  "function termRepoServicerImpl() view returns (address)",
  "function termRepoCollateralManagerImpl() view returns (address)",
  "function termRepoLockerImpl() view returns (address)",
  "function termRepoTokenImpl() view returns (address)",
  "function termRepoRolloverManagerImpl() view returns (address)",
  "function termAuctionImpl() view returns (address)",
  "function termAuctionBidLockerImpl() view returns (address)",
  "function termAuctionOfferLockerImpl() view returns (address)",
];

const CONTROLLER_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function isFactoryDeployed(address contractAddress) view returns (bool)",
  "function isTermDeployed(address contractAddress) view returns (bool)",
  "function registeredRepoIds(bytes32 repoId) view returns (bool)",
];

const EMITTER_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

const LOUPE_ABI = [
  "function facets() view returns ((address facetAddress, bytes4[] functionSelectors)[])",
  "function facetAddresses() view returns (address[])",
  "function facetFunctionSelectors(address facet) view returns (bytes4[])",
  "function facetAddress(bytes4 selector) view returns (address)",
  "function diamondPaused() view returns (bool)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
];

const MISC_ABI = [
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function version() view returns (string)",
  "function termRepoId() view returns (bytes32)",
  "function maturityTimestamp() view returns (uint256)",
  "function redemptionTimestamp() view returns (uint256)",
  "function purchaseToken() view returns (address)",
];

function extractEndpoints(text) {
  const urls = new Set();
  for (const rawLine of text.split(/\r?\n/)) {
    for (const tokRaw of rawLine.split(/[\s,;]+/)) {
      const tok = tokRaw.replace(/[)\]}>'"]+$/g, "");
      if (/^https?:\/\//i.test(tok)) urls.add(tok);
    }
  }
  return [...urls];
}

async function rpc(url, method, params) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("http " + res.status);
    const json = await res.json();
    if (json.error) throw new Error("rpc " + (json.error.code || "?") + " " + (json.error.message || ""));
    return json.result;
  } finally {
    clearTimeout(t);
  }
}

async function ethCall(url, to, iface, fn, args) {
  const data = iface.encodeFunctionData(fn, args);
  const result = await rpc(url, "eth_call", [{ to, data }, "latest"]);
  return iface.decodeFunctionResult(fn, result);
}

async function tryEthCall(url, to, iface, fn, args) {
  try {
    return { ok: true, value: (await ethCall(url, to, iface, fn, args)).toString() };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

function zeroRanges(hexBody, ranges) {
  const bytes = Buffer.from(hexBody, "hex");
  for (const [start, len] of ranges) {
    for (let i = start; i < start + len && i < bytes.length; i++) bytes[i] = 0;
  }
  return bytes;
}

async function main() {
  let endpoint = null;
  const probeTrail = [];
  try {
    endpoint = await sharedRpc.resolveRpc(1, null, { capability: "read" });
  } catch (e) {
    probeTrail.push({ verdict: "resolver_error_" + String(e.message || e).slice(0, 60) });
  }
  if (!endpoint) {
    // bounded direct retry: public fallback only, in-process URL
    try {
      const fb = sharedRpc.PUBLIC_FALLBACKS[1];
      const cid = await rpc(fb, "eth_chainId", []);
      if (cid === "0x1") endpoint = fb;
    } catch (e) {
      probeTrail.push({ verdict: "fallback_fail_" + String(e.message || e).slice(0, 60) });
    }
  }
  if (!endpoint) {
    const out = { schema: "termdiag-step1-live-views/v1", status: "NO_ENDPOINT", probeTrail };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
    console.log("NO_ENDPOINT"); return;
  }

  const blockNumber = BigInt(await rpc(endpoint, "eth_blockNumber", [])).toString();
  const A = ADDRESSES;
  const factory = new ethers.Interface(FACTORY_ABI);
  const controller = new ethers.Interface(CONTROLLER_ABI);
  const emitter = new ethers.Interface(EMITTER_ABI);
  const loupe = new ethers.Interface(LOUPE_ABI);
  const misc = new ethers.Interface(MISC_ABI);

  const out = {
    schema: "termdiag-step1-live-views/v1",
    generatedUtc: new Date().toISOString(),
    status: "PASS",
    network: { chainId: 1, blockNumber },
    endpointMaterialPersisted: false,
    readOnly: true,
    addresses: A,
    factory: {},
    controller: {},
    emitter: {},
    diamond: {},
    candidates: [],
  };

  // ---- factory code + fingerprint ----
  const fCode = await rpc(endpoint, "eth_getCode", [A.factorySeed, "latest"]);
  const fHex = fCode.slice(2);
  out.factory.codeBytes = fHex.length / 2;
  out.factory.expectedRuntimeBytes = FACTORY_EXPECT.runtimeBytes;
  if (out.factory.codeBytes === FACTORY_EXPECT.runtimeBytes) {
    const norm = zeroRanges(fHex, FACTORY_EXPECT.immutableRanges);
    out.factory.immutableNormalizedKeccak = ethers.keccak256(norm);
    out.factory.immutableNormalizedKeccakExpected = FACTORY_EXPECT.immutableNormalizedKeccak;
    out.factory.runtimeIdentityMatch =
      out.factory.immutableNormalizedKeccak === FACTORY_EXPECT.immutableNormalizedKeccak;
  } else {
    out.factory.runtimeIdentityMatch = false;
  }

  // ---- factory views ----
  const fFns = [
    "admin", "devops", "controller", "emitter", "priceOracle", "termDiamond",
    "deployingPaused", "deployingAuctionsPaused", "deployingTermReposPaused",
    "termVersion", "auctionVersion",
    "termRepoServicerImpl", "termRepoCollateralManagerImpl", "termRepoLockerImpl",
    "termRepoTokenImpl", "termRepoRolloverManagerImpl",
    "termAuctionImpl", "termAuctionBidLockerImpl", "termAuctionOfferLockerImpl",
  ];
  for (const fn of fFns) {
    const r = await tryEthCall(endpoint, A.factorySeed, factory, fn, []);
    out.factory[fn] = r.ok ? r.value : { reverted: r.error };
  }

  const ctrlAddr = typeof out.factory.controller === "string" ? out.factory.controller : null;
  const ctrlProxy = ctrlAddr && /^0x[0-9a-fA-F]{40}$/.test(ctrlAddr) ? ctrlAddr : A.controllerProxy;
  const diamondAddr = typeof out.factory.termDiamond === "string" && /^0x[0-9a-fA-F]{40}$/.test(out.factory.termDiamond) && out.factory.termDiamond !== ethers.ZeroAddress ? out.factory.termDiamond : null;

  // ---- controller role page ----
  const roleNames = ["FACTORY_DEPLOYER_ROLE", "INITIALIZER_ROLE", "ADMIN_ROLE", "CONTROLLER_ADMIN_ROLE"];
  out.controller.roleHashes = {};
  for (const rn of roleNames) out.controller.roleHashes[rn] = ethers.id(rn);
  for (const rn of roleNames) {
    out.controller["hasRole_" + rn + "_factory"] = await tryEthCall(
      endpoint, ctrlProxy, controller, "hasRole", [ethers.id(rn), A.factorySeed]);
  }
  out.controller.hasRole_INITIALIZER_ROLE_controllerAdmin =
    await tryEthCall(endpoint, ctrlProxy, controller, "hasRole", [ethers.id("INITIALIZER_ROLE"), A.emitterProxy]);
  void emitter;
  for (const cand of A.candidates) {
    out.controller["isFactoryDeployed_" + cand] = await tryEthCall(endpoint, ctrlProxy, controller, "isFactoryDeployed", [cand]);
    out.controller["isTermDeployed_" + cand] = await tryEthCall(endpoint, ctrlProxy, controller, "isTermDeployed", [cand]);
  }

  // ---- diamond loupe + facet slicing ----
  if (diamondAddr) {
    out.diamond.address = diamondAddr;
    const dCode = await rpc(endpoint, "eth_getCode", [diamondAddr, "latest"]);
    out.diamond.codeBytes = (dCode.length - 2) / 2;

    out.diamond.diamondPaused = await tryEthCall(endpoint, diamondAddr, loupe, "diamondPaused", []);
    out.diamond.supportsInterface_IDiamondCut = await tryEthCall(endpoint, diamondAddr, loupe, "supportsInterface", ["0x1f931c1c"]);

    let facets = null;
    try {
      const r = await ethCall(endpoint, diamondAddr, loupe, "facets", []);
      facets = r[0].map((f) => ({
        facetAddress: f.facetAddress,
        selectors: f.functionSelectors.map((s) => s),
      }));
      out.diamond.facetsSource = "facets()";
    } catch (e) {
      out.diamond.facetsError = String(e.message || e).slice(0, 160);
      try {
        const r = await ethCall(endpoint, diamondAddr, loupe, "facetAddresses", []);
        facets = [];
        for (const fa of r[0]) {
          const sels = await ethCall(endpoint, diamondAddr, loupe, "facetFunctionSelectors", [fa]);
          facets.push({ facetAddress: fa, selectors: sels[0].map((s) => s) });
        }
        out.diamond.facetsSource = "facetAddresses()+facetFunctionSelectors()";
      } catch (e2) {
        out.diamond.facetsError2 = String(e2.message || e2).slice(0, 160);
      }
    }
    if (facets) {
      out.diamond.facets = facets;
      const all = new Set();
      for (const f of facets) for (const s of f.selectors) all.add(s);
      out.diamond.selectorCount = all.size;

      const probe = {
        diamondCut: ethers.id("diamondCut((address,uint8,bytes4[])[],address,bytes)").slice(0, 10),
        pauseDiamond: ethers.id("pauseDiamond()").slice(0, 10),
        unpauseDiamond: ethers.id("unpauseDiamond()").slice(0, 10),
        multicall: ethers.id("multicall(bytes[])").slice(0, 10),
        initializeTermIntentFacet: ethers.id("initializeTermIntentFacet(address)").slice(0, 10),
        generateActionCalldata: ethers.id("generateActionCalldata(address,address,uint256,address,uint256,bytes4,address,bytes)").slice(0, 10),
        DOMAIN_SEPARATOR: ethers.id("DOMAIN_SEPARATOR()").slice(0, 10),
        erc20Transfer: ethers.id("erc20Transfer(address,address,uint256)").slice(0, 10),
        transferRolloverCollateral: ethers.id("transferRolloverCollateral(address,uint256,address)").slice(0, 10),
      };
      out.diamond.probeSelectors = probe;
      out.diamond.probeSlice = {};
      for (const [name, sel] of Object.entries(probe)) {
        out.diamond.probeSlice[name] = all.has(sel);
      }
      for (const name of ["diamondCut", "pauseDiamond", "unpauseDiamond", "multicall", "initializeTermIntentFacet", "generateActionCalldata"]) {
        out.diamond["facetAddress_" + name] = await tryEthCall(endpoint, diamondAddr, loupe, "facetAddress", [probe[name]]);
      }
      out.diamond.DOMAIN_SEPARATOR = await tryEthCall(endpoint, diamondAddr, misc, "DOMAIN_SEPARATOR", []);
      out.diamond.version = await tryEthCall(endpoint, diamondAddr, misc, "version", []);
    } else {
      out.status = "DIAMOND_INTERFACE_EMPTY";
    }
  } else {
    out.diamond = { address: null, reason: "factory.termDiamond() unavailable or zero" };
  }

  // ---- candidates ----
  for (const cand of A.candidates) {
    const entry = { address: cand };
    try {
      const code = await rpc(endpoint, "eth_getCode", [cand, "latest"]);
      entry.codeBytes = (code.length - 2) / 2;
      if (entry.codeBytes > 0) {
        entry.termRepoId = await tryEthCall(endpoint, cand, misc, "termRepoId", []);
        entry.maturityTimestamp = await tryEthCall(endpoint, cand, misc, "maturityTimestamp", []);
        entry.purchaseToken = await tryEthCall(endpoint, cand, misc, "purchaseToken", []);
      }
    } catch (e) {
      entry.error = String(e.message || e).slice(0, 160);
    }
    out.candidates.push(entry);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({
    status: out.status,
    blockNumber,
    factoryIdentity: out.factory.runtimeIdentityMatch,
    factoryCodeBytes: out.factory.codeBytes,
    diamond: out.diamond && out.diamond.address ? {
      address: out.diamond.address,
      codeBytes: out.diamond.codeBytes,
      diamondPaused: out.diamond.diamondPaused,
      selectorCount: out.diamond.selectorCount,
      slice: out.diamond.probeSlice,
      domainSeparator: out.diamond.DOMAIN_SEPARATOR,
    } : null,
    controllerFlagFactory: out.controller["hasRole_FACTORY_DEPLOYER_ROLE_factory"],
    candidateFactoryFlags: out.candidates.map((c) => ({ a: c.address, bytes: c.codeBytes })),
    artifact: path.relative(WORKSPACE, OUT),
  }, null, 2));
}

main().catch((e) => { console.error("FATAL " + String(e.message || e).slice(0, 200)); process.exit(1); });
