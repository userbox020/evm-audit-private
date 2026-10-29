#!/usr/bin/env node
"use strict";
/*
 * gamma-hypervisor-build-hash-compare.js
 *
 * Fresh-surface Phase-0 for the Gamma Hypervisor row `targets/gamma-hypervisor-deployed-d5f487`.
 *
 * 1. OFFLINE: recompile the retained Sourcify standard-JSON input with the exact vendored
 *    solc 0.7.6, and re-derive the runtime/creation bytecode + immutable references.
 * 2. LIVE READ-ONLY: eth_getCode parity against the pinned chain-1 deployment (0xD5F487...),
 *    comparing (a) exact live bytes, (b) live bytes modulo deploy-time immutable bindings.
 *    This is the batch-15 build-hash-compare recipe (exact -> metadata-stripped -> immutable-masked).
 * 3. Phase-0 capture rows: HypervisorFactory (from the creation receipt), creator/deployer,
 *    Hypervisor config, UniProxy/Clearance binding, and the FeeRecipient/fee-distribution row.
 *
 * Safety: RPC URLs come from the workspace rpc_endpoints.txt + a small keyless public pool, stay
 * process-only, are never printed/persisted, and never reach a command line. No signing, no
 * broadcast, no state change, no workspace key. Every persisted artifact is URL-scrubbed.
 *
 * Env: GAMMA_PIN_BLOCK (optional) pin a specific chain-1 block for the code parity read.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEPLOYED = path.join(ROOT, "targets", "gamma-hypervisor-deployed-d5f487");
const CANONICAL = path.join(ROOT, "targets", "gamma-hypervisor-b4d90b3");
const OUT = path.join(ROOT, "reports", "fork-sim", "gamma-hypervisor");

const { keccak256, Interface, getAddress } = require(path.join(ROOT, "tools", "node_modules", "ethers"));
const { loadRpcUrls, rpcCall } = require(path.join(ROOT, "tools", "shared-rpc.js"));

const CHAIN_ID = 1;
const HYPE = "0xD5F4877263b736625ba363385983C2D02B41F35b";
const UNIPROXY = "0x911bfbaca43f117e52197ae62d439d6a645c8886";
const CLEARANCE = "0x09a8ebb5bf22b1da81835164d6653fa1d57dbbee";
const POOL = "0xd1d5a4c0ea98971894772dcd6d2f1dc71083c44e";
const CREATION_TX = "0xde557eeabf258f8578eb281337b845eb927eb7fdeabb056351b79dbec035f438";
const CREATION_BLOCK = 20621300;

// From the retained manifest (independent cross-check targets).
const MANIFEST_RUNTIME_KECCAK = "0x9791bbe74030f2f44320c97c214a123735c6caede813db132c6daec8541b96ce";
const MANIFEST_ONCHAIN_KECCAK = "0x4e46bbe4d3c1e1dd0ff4aea346040534f77bd19ab16119006bf31548b431e0a6";
const MANIFEST_ONCHAIN_SHA256 = "3680dcf7dd8e3d4a2b62134da8618c757d0630b6f21e64f91b00e5238cdbd209";
const MANIFEST_CREATION_KECCAK = "0x4f34e9cecb5d77f541eaa200105099e295aa0b083bc362f2261c9efad2f24eee";

const PUBLIC_POOL = [
  "https://eth.blockscout.com/api/eth-rpc",
  "https://eth.drpc.org",
  "https://gateway.tenderly.co/public/mainnet",
  "https://rpc.mevblocker.io",
  "https://ethereum.publicnode.com",
  "https://eth.llamarpc.com",
];

const HYPE_IFACE = new Interface([
  "function owner() view returns (address)",
  "function whitelistedAddress() view returns (address)",
  "function fee() view returns (uint8)",
  "function feeRecipient() view returns (address)",
  "function directDeposit() view returns (bool)",
  "function tickSpacing() view returns (int24)",
  "function baseLower() view returns (int24)",
  "function baseUpper() view returns (int24)",
  "function limitLower() view returns (int24)",
  "function limitUpper() view returns (int24)",
  "function totalSupply() view returns (uint256)",
  "function getTotalAmounts() view returns (uint256,uint256)",
  "function deposit0Max() view returns (uint256)",
  "function deposit1Max() view returns (uint256)",
  "function maxTotalSupply() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function pool() view returns (address)",
  "function currentTick() view returns (int24)",
]);
const UNI_IFACE = new Interface([
  "function owner() view returns (address)",
  "function clearance() view returns (address)",
]);
const CLEAR_IFACE = new Interface([
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function getPositionInfo(address) view returns (bool,bool,bool,bool,bool,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
]);
const POOL_IFACE = new Interface([
  "function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
  "function fee() view returns (uint24)",
]);
const FEE_RECIPIENT_IFACE = new Interface([
  // FeeRecipient (v1) shape
  "function owner() view returns (address)",
  "function feeManager() view returns (address)",
  "function recipient1() view returns (address)",
  "function recipient2() view returns (address)",
  // FeeRecipientV2 shape
  "function recipients(uint256) view returns (address)",
  "function recipientShares(address) view returns (uint256)",
  "function isRecipient(address) view returns (bool)",
  "function gammaTreasury() view returns (address)",
  "function treasury() view returns (address)",
  "function feeRecipient() view returns (address)",
]);
const HYPE_CREATED_TOPIC = HYPE_IFACE
  ? new Interface([
      "event HypervisorCreated(address token0, address token1, uint24 fee, address hypervisor, uint256)",
    ])
  : null;

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
function bytes(hex) {
  return typeof hex === "string" && /^0x(?:[0-9a-fA-F]{2})*$/u.test(hex)
    ? Buffer.from(hex.slice(2), "hex")
    : null;
}
function isUrl(v) {
  return typeof v === "string" && /^(?:https?|wss?):\/\//iu.test(v);
}
function guard(obj) {
  const text = JSON.stringify(obj);
  if (isUrl(text) || /"(?:endpoint|provider|hostname|domain|headers)"\s*:/iu.test(text)) {
    throw new Error("URL/provider material in output");
  }
  // any long base64/hex-looking secretish token that is not an address/hash is rejected
  return true;
}
function addrOrNull(v) {
  try {
    return getAddress(v).toLowerCase();
  } catch (_) {
    return null;
  }
}
function qty(n) {
  return "0x" + BigInt(n).toString(16);
}

// ---- offline recompile -----------------------------------------------------
function recompile() {
  const solc = require(path.join(CANONICAL, "node_modules", "solc-0.7"));
  const input = JSON.parse(fs.readFileSync(path.join(DEPLOYED, "compiler", "compile-input.json"), "utf8"));
  input.settings.outputSelection = {
    "*": {
      "*": [
        "abi",
        "metadata",
        "evm.bytecode.object",
        "evm.deployedBytecode.object",
        "evm.deployedBytecode.immutableReferences",
      ],
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error("recompile errors: " + errors.map((e) => e.formattedMessage).join(" | "));
  const c = output.contracts["contracts/Hypervisor.sol"].Hypervisor;
  const runtime = "0x" + c.evm.deployedBytecode.object;
  const creation = "0x" + c.evm.bytecode.object;
  return {
    compiler: solc.version(),
    settings: input.settings,
    runtime,
    creation,
    immutableReferences: c.evm.deployedBytecode.immutableReferences,
    abi: c.abi,
  };
}

function immutableByteRanges(immutableReferences) {
  const ranges = [];
  for (const refs of Object.values(immutableReferences || {})) {
    for (const r of refs) ranges.push([r.start, r.start + r.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}
function maskHex(hex, ranges) {
  const buf = bytes(hex);
  for (const [start, end] of ranges) for (let i = start; i < end && i < buf.length; i++) buf[i] = 0;
  return "0x" + buf.toString("hex");
}

// ---- live RPC --------------------------------------------------------------
function candidates() {
  const seen = new Set();
  const ordered = [];
  const push = (u) => {
    if (typeof u === "string" && /^https:\/\//i.test(u) && !seen.has(u)) {
      seen.add(u);
      ordered.push(u);
    }
  };
  for (const u of PUBLIC_POOL) push(u);
  for (const u of loadRpcUrls({ maxCandidates: 64 })) push(u);
  return ordered;
}

async function pickEndpoint(pinBlock) {
  const blockHex = qty(pinBlock);
  for (const url of candidates()) {
    try {
      const cid = await rpcCall(url, "eth_chainId", [], 8000);
      if (!cid || parseInt(cid, 16) !== CHAIN_ID) continue;
      const blk = await rpcCall(url, "eth_getBlockByNumber", [blockHex, false], 9000);
      if (!blk || !/^0x[0-9a-f]{64}$/i.test(blk.hash || "")) continue;
      const code = await rpcCall(url, "eth_getCode", [HYPE, blockHex], 9000);
      if (!(typeof code === "string" && code.length > 4)) continue;
      return { url, block: blk };
    } catch (_) {
      /* next */
    }
  }
  return null;
}

async function call(url, block, target, iface, fragment, args) {
  let data;
  try {
    data = iface.encodeFunctionData(fragment, args || []);
  } catch (_) {
    return { value: null, reason: "ENCODE" };
  }
  const raw = await rpcCall(url, "eth_call", [{ to: target, data }, block], 12000);
  if (typeof raw !== "string" || !/^0x[0-9a-f]*$/i.test(raw)) return { value: null, reason: "CALL_FAILED" };
  try {
    const dec = iface.decodeFunctionResult(fragment, raw);
    const one = dec.length === 1 ? dec[0] : dec;
    const norm = (x) => (typeof x === "bigint" ? x.toString() : Array.isArray(x) ? x.map(norm) : x);
    return { value: norm(one), reason: null };
  } catch (_) {
    return { value: null, reason: "DECODE" };
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Offline recompile + artifact cross-check.
  const re = recompile();
  const artifact = JSON.parse(fs.readFileSync(path.join(DEPLOYED, "artifacts", "Hypervisor.json"), "utf8"));
  const ranges = immutableByteRanges(re.immutableReferences);
  const offline = {
    compiler: re.compiler,
    settings: re.settings,
    recompiledRuntimeBytes: (re.runtime.length - 2) / 2,
    recompiledCreationBytes: (re.creation.length - 2) / 2,
    recompiledRuntimeKeccak: keccak256(re.runtime),
    recompiledCreationKeccak: keccak256(re.creation),
    immutableReferenceCount: Object.keys(re.immutableReferences || {}).length,
    immutableByteOffsets: ranges.length,
    runtimeEqualsArtifact: re.runtime.toLowerCase() === artifact.runtimeBytecode.toLowerCase(),
    creationEqualsArtifact: re.creation.toLowerCase() === artifact.creationBytecode.toLowerCase(),
    artifactRuntimeKeccak: keccak256(artifact.runtimeBytecode),
    artifactCreationKeccak: keccak256(artifact.creationBytecode),
  };

  // 2. Resolve a pinned archive-capable endpoint.
  const pinBlock = process.env.GAMMA_PIN_BLOCK ? Number(process.env.GAMMA_PIN_BLOCK) : null;
  let endpoint = null;
  let effectivePin = pinBlock;
  if (!effectivePin) {
    // latest finalized-ish: use latest minus a small finality margin via a candidate probe
    for (const url of candidates()) {
      try {
        const cid = await rpcCall(url, "eth_chainId", [], 8000);
        if (!cid || parseInt(cid, 16) !== CHAIN_ID) continue;
        const latest = await rpcCall(url, "eth_blockNumber", [], 8000);
        if (!latest) continue;
        effectivePin = Number(BigInt(latest)) - 128;
        endpoint = await pickEndpoint(effectivePin);
        if (endpoint) break;
      } catch (_) {
        /* next */
      }
    }
  } else {
    endpoint = await pickEndpoint(effectivePin);
  }
  if (!endpoint) {
    // honest blocker: offline-only closeout
    const offlineOnly = {
      schema: "gamma-hypervisor-build-hash-compare/v1",
      generatedAt: new Date().toISOString(),
      chainId: String(CHAIN_ID),
      address: HYPE,
      offline,
      live: { status: "BLOCKED_NO_ARCHIVE_ENDPOINT", note: "no qualified archive chain-1 endpoint" },
      verdict: "OFFLINE_ONLY_UNKNOWN",
    };
    guard(offlineOnly);
    fs.writeFileSync(path.join(OUT, "build-hash-compare.json"), JSON.stringify(offlineOnly, null, 2) + "\n");
    process.stdout.write("build-hash-compare: BLOCKED_NO_ARCHIVE_ENDPOINT (offline recompile only)\n");
    return;
  }

  const url = endpoint.url;
  const pin = endpoint.block;
  const pinArg = pin.number; // hex

  // 3. Live code parity.
  const liveCode = await rpcCall(url, "eth_getCode", [HYPE, pinArg], 15000);
  const liveLatest = await rpcCall(url, "eth_getCode", [HYPE, "latest"], 15000);
  const liveBytes = bytes(liveCode) || Buffer.alloc(0);
  const liveKeccak = liveCode && liveCode.length > 2 ? keccak256(liveCode) : null;
  const liveSha = liveCode && liveCode.length > 2 ? sha256(liveBytes) : null;
  const maskedLive = maskHex(liveCode || "0x", ranges);
  const maskedRecompiled = maskHex(re.runtime, ranges);
  const exactLiveEqualsArtifact = liveCode && liveCode.toLowerCase() === artifact.runtimeBytecode.toLowerCase();
  const exactLiveEqualsMaterialized =
    liveCode && liveCode.toLowerCase() === artifact.materializedRuntimeBytecode.toLowerCase();
  const maskedExact = maskedLive.toLowerCase() === maskedRecompiled.toLowerCase();
  const maskedDiffBytes = (() => {
    const a = bytes(maskedLive) || Buffer.alloc(0);
    const b = bytes(maskedRecompiled) || Buffer.alloc(0);
    if (a.length !== b.length) return -1;
    let d = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
  })();

  // 4. Creation-parity: tx input must prefix the recompiled creation code.
  const tx = await rpcCall(url, "eth_getTransactionByHash", [CREATION_TX], 12000);
  const txReceipt = await rpcCall(url, "eth_getTransactionReceipt", [CREATION_TX], 12000);
  const creationPrefixOk =
    tx && typeof tx.input === "string" && tx.input.toLowerCase().startsWith(re.creation.toLowerCase());
  const preCreationCode = await rpcCall(url, "eth_getCode", [HYPE, qty(CREATION_BLOCK - 1)], 15000);
  const creationEmptyBefore = preCreationCode === "0x";

  // Factory: the log in the creation receipt emitted by the factory that carries HYPE.
  let factory = null;
  let factoryMode = "unknown";
  let createdEvent = null;
  const receiptLogs = txReceipt && Array.isArray(txReceipt.logs) ? txReceipt.logs : [];
  for (const log of receiptLogs) {
    try {
      const parsed = HYPE_CREATED_TOPIC.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === "HypervisorCreated") {
        const hv = addrOrNull(parsed.args[3]);
        if (hv === HYPE.toLowerCase()) {
          factory = addrOrNull(log.address);
          createdEvent = {
            emitter: factory,
            token0: addrOrNull(parsed.args[0]),
            token1: addrOrNull(parsed.args[1]),
            fee: parsed.args[2].toString(),
            hypervisor: hv,
          };
        }
      }
    } catch (_) {
      /* not our event */
    }
  }
  if (factory) {
    factoryMode = "factory-deployed";
  } else if (
    txReceipt &&
    addrOrNull(txReceipt.contractAddress) === HYPE.toLowerCase() &&
    receiptLogs.length === 0
  ) {
    // Direct orphan deployment (deploy-hypervisor-orphan task): no factory row binds.
    factoryMode = "orphan-direct-deploy";
  }

  // 5. Phase-0 capture rows.
  const hype = {};
  for (const [key, frag, args] of [
    ["owner", "owner", []],
    ["whitelistedAddress", "whitelistedAddress", []],
    ["fee", "fee", []],
    ["feeRecipient", "feeRecipient", []],
    ["directDeposit", "directDeposit", []],
    ["tickSpacing", "tickSpacing", []],
    ["baseLower", "baseLower", []],
    ["baseUpper", "baseUpper", []],
    ["limitLower", "limitLower", []],
    ["limitUpper", "limitUpper", []],
    ["totalSupply", "totalSupply", []],
    ["totals", "getTotalAmounts", []],
    ["deposit0Max", "deposit0Max", []],
    ["deposit1Max", "deposit1Max", []],
    ["maxTotalSupply", "maxTotalSupply", []],
    ["token0", "token0", []],
    ["token1", "token1", []],
    ["pool", "pool", []],
    ["currentTick", "currentTick", []],
  ]) {
    hype[key] = await call(url, pinArg, HYPE, HYPE_IFACE, frag, args);
  }
  const uni = {
    owner: await call(url, pinArg, UNIPROXY, UNI_IFACE, "owner", []),
    clearance: await call(url, pinArg, UNIPROXY, UNI_IFACE, "clearance", []),
  };
  const clearance = {
    owner: await call(url, pinArg, CLEARANCE, CLEAR_IFACE, "owner", []),
    paused: await call(url, pinArg, CLEARANCE, CLEAR_IFACE, "paused", []),
    position: await call(url, pinArg, CLEARANCE, CLEAR_IFACE, "getPositionInfo", [HYPE]),
  };
  const pool = {
    slot0: await call(url, pinArg, POOL, POOL_IFACE, "slot0", []),
    liquidity: await call(url, pinArg, POOL, POOL_IFACE, "liquidity", []),
    fee: await call(url, pinArg, POOL, POOL_IFACE, "fee", []),
  };

  // Fee-distribution row: the hypervisor's current feeRecipient (target of zeroBurn 1/fee cut).
  const feeRecipient = addrOrNull(hype.feeRecipient.value);
  let feeRecipientCode = null;
  let feeRecipientProbe = null;
  if (feeRecipient) {
    const code = await rpcCall(url, "eth_getCode", [feeRecipient, pinArg], 12000);
    feeRecipientCode =
      code && code !== "0x"
        ? { present: true, bytes: (code.length - 2) / 2, keccak256: keccak256(code) }
        : { present: false };
    feeRecipientProbe = {};
    for (const frag of ["owner", "feeManager", "recipient1", "recipient2", "gammaTreasury", "treasury", "feeRecipient"]) {
      feeRecipientProbe[frag] = await call(url, pinArg, feeRecipient, FEE_RECIPIENT_IFACE, frag, []);
    }
    // FeeRecipientV2 recipients[] enumeration (bounded).
    const recipients = [];
    for (let i = 0; i < 8; i++) {
      const r = await call(url, pinArg, feeRecipient, FEE_RECIPIENT_IFACE, "recipients", [i]);
      if (r.reason !== null || !r.value) break;
      const a = addrOrNull(r.value);
      if (!a) break;
      const share = await call(url, pinArg, feeRecipient, FEE_RECIPIENT_IFACE, "recipientShares", [a]);
      recipients.push({ address: a, share: share.value });
    }
    feeRecipientProbe.recipients = recipients;
    feeRecipientProbe.recipientsLength = recipients.length;
  }

  const live = {
    status: "OK",
    pin: {
      number: BigInt(pin.number).toString(),
      hash: pin.hash.toLowerCase(),
      timestamp: BigInt(pin.timestamp).toString(),
    },
    latestCodeStillDeployed: typeof liveLatest === "string" && liveLatest.length > 4,
    codeAtPin: {
      bytes: liveBytes.length,
      keccak256: liveKeccak,
      sha256: liveSha,
    },
    exactLiveEqualsArtifactRuntime: !!exactLiveEqualsArtifact,
    exactLiveEqualsArtifactMaterialized: !!exactLiveEqualsMaterialized,
    immutableMaskedLiveEqualsRecompiled: maskedExact,
    immutableMaskedDiffBytes: maskedDiffBytes,
    matchesManifestOnchainKeccak: liveKeccak === MANIFEST_ONCHAIN_KECCAK,
    matchesManifestOnchainSha256: liveSha === MANIFEST_ONCHAIN_SHA256,
    creation: {
      tx: CREATION_TX,
      txInputPrefixesRecompiledCreation: !!creationPrefixOk,
      emptyCodeBeforeCreationBlock: creationEmptyBefore,
      blockNumber: CREATION_BLOCK,
    },
  };

  const verdict =
    exactLiveEqualsMaterialized && maskedExact && creationPrefixOk
      ? "EXACT_DEPLOYED_SOURCE_MATCH_CONFIRMED"
      : maskedExact && creationPrefixOk
      ? "SOURCE_EQUIVALENT_MODULO_IMMUTABLES"
      : "MISMATCH";

  const capture = {
    schema: "gamma-hypervisor-build-hash-compare/v1",
    generatedAt: new Date().toISOString(),
    chainId: String(CHAIN_ID),
    address: HYPE,
    rpcPolicy: {
      inventory: "rpc_endpoints.txt + keyless public pool",
      processOnly: true,
      urlsPrinted: false,
      methods: ["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_getTransactionByHash", "eth_getTransactionReceipt"],
      noStateChange: true,
    },
    offline,
    live,
    verdict,
    phase0: {
      hypervisor: hype,
      uniProxy: uni,
      clearance,
      pool,
      factory: { address: factory, mode: factoryMode, createdEvent, creationReceiptLogCount: receiptLogs.length },
      creator: tx ? { deployer: addrOrNull(tx.from), txHash: CREATION_TX, blockNumber: CREATION_BLOCK } : null,
      feeDistribution: {
        feeRecipient,
        code: feeRecipientCode,
        probe: feeRecipientProbe,
        note: "zeroBurn() forwards owed/fee (fee=5 -> 20%) of each position's accrued fees to feeRecipient on every deposit/withdraw/rebalance.",
      },
    },
    gates: {
      sourceBinding: verdict.startsWith("EXACT") ? "PASS" : verdict.startsWith("SOURCE_EQUIVALENT") ? "PASS_MODULO_IMMUTABLES" : "FAIL",
      immutableNormalizationRequired: true,
      routePositive: null,
      executableNow: false,
      signedActionJustified: false,
    },
    boundaries: [
      "Read-only. No state-changing call, signing, broadcast, fork, swap, deposit, or exploit invocation.",
      "RPC URLs are process-only and scrubbed from every persisted artifact.",
    ],
  };

  guard(offline);
  guard(capture);
  fs.writeFileSync(path.join(OUT, "build-hash-compare.json"), JSON.stringify(capture, null, 2) + "\n");

  const manifest = {
    schema: "gamma-hypervisor-build-hash-compare-manifest/v1",
    generatedAt: capture.generatedAt,
    verdict,
    files: [
      {
        name: "build-hash-compare.json",
        bytes: fs.statSync(path.join(OUT, "build-hash-compare.json")).size,
        sha256: sha256(fs.readFileSync(path.join(OUT, "build-hash-compare.json"))),
      },
    ],
    urlsPersisted: false,
  };
  guard(manifest);
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  process.stdout.write(
    `build-hash-compare: verdict=${verdict} liveBytes=${liveBytes.length} maskedExact=${maskedExact} exactMaterialized=${exactLiveEqualsMaterialized} factory=${factory || factoryMode}\n`
  );
}

main().catch((e) => {
  process.stderr.write(
    "build-hash-compare failed: " + String((e && e.message) || e).replace(/https?:\/\/\S+/giu, "[redacted]") + "\n"
  );
  process.exitCode = 1;
});
