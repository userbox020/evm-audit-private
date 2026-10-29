#!/usr/bin/env node
// verify-deployed-bytecode.js — compare deployed runtime bytecode to local Foundry artifacts.
// RPC URLs are read from rpc_endpoints.txt and never printed or written.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "deployed-bytecode-verification.json");

const ART = {
  E1: "exploits/compound-stale-oracle/out/CompoundStaleOracleExploit.sol/CompoundStaleOracleExploit.json",
  E5: "exploits/depeg-exploit/out/DepegExploit.sol/DepegExploit.json",
  E8: "exploits/fluid-stale-oracle/out/FlashLoanExploit.sol/FlashLoanStaleOracleExploit.json",
  E10Base: "exploits/cross-chain-oracle/out/E10AaveBaseExploit.sol/E10AaveBaseExploit.json",
  E10Generic: "exploits/cross-chain-oracle/out/E10GenericExploit.sol/E10GenericExploit.json",
  LB: "exploits/liquity-bold/out/LiquityBoldExploit.sol/LiquityBoldExploit.json",
  E9: "contracts/flash-liquidate-aave-v3/out/FlashLiquidateMorpho.sol/FlashLiquidateMorpho.json",
  FlashLiquidateAaveV3: "contracts/flash-liquidate-aave-v3/out/FlashLiquidateAaveV3.sol/FlashLiquidateAaveV3.json",
  FlashLiquidateMorphoBlue: "contracts/flash-liquidate-morpho-blue/out/FlashLiquidateMorphoBlue.sol/FlashLiquidateMorphoBlue.json",
  FlashLiquidateEulerEVK: "contracts/flash-liquidate-euler-evk/out/FlashLiquidateEulerEVK.sol/FlashLiquidateEulerEVK.json",
  FltLiquidateT2T4: "contracts/flash-liquidate-fluid-t2t4/out/FltLiquidateT2T4.sol/FltLiquidateT2T4.json",
  E12x: "exploits/morpho-market-exploit/out/GenericMorphoExploit.sol/GenericMorphoExploit.json",
};

const TARGETS = [
  { label: "E1/CAPO", chainId: 1, chain: "Ethereum", address: "0xe1797A807A5dBf774dBD149e844B18C922E695Eb", artifacts: [ART.E1], searchRoot: "exploits/compound-stale-oracle/out", deployJson: "exploits/compound-stale-oracle/deploy.json" },
  { label: "E5", chainId: 1, chain: "Ethereum", address: "0x81F2FCF80ADecd464d88AD01Aa3Afe3D7919E583", artifacts: [ART.E5], searchRoot: "exploits/depeg-exploit/out", deployJson: "exploits/depeg-exploit/deploy.json" },
  { label: "E8", chainId: 1, chain: "Ethereum", address: "0xb795fEB4d24d4Da7C55D6343aaC988b940d948E8", artifacts: [ART.E8], searchRoot: "exploits/fluid-stale-oracle/out", deployJson: "exploits/fluid-stale-oracle/deploy.json" },
  { label: "LB", chainId: 1, chain: "Ethereum", address: "0x0aaA75499FbcB7db821c3AefC84433A53CDEb9b9", artifacts: [ART.LB], searchRoot: "exploits/liquity-bold/out" },
  { label: "AAVE-LIQ-V3", chainId: 1, chain: "Ethereum", address: "0x1c4bc8d8b5806c1d73b47bc7ae4c2b6552c858a1", artifacts: [ART.FlashLiquidateAaveV3], searchRoot: "contracts/flash-liquidate-aave-v3/out" },
  { label: "MORPHO-LIQ-V3", chainId: 1, chain: "Ethereum", address: "0xaf5b033e23ac555c09096bf39979a855e09907ba", artifacts: [ART.FlashLiquidateMorphoBlue], searchRoot: "contracts/flash-liquidate-morpho-blue/out" },
  { label: "EULER-LIQ-V3", chainId: 1, chain: "Ethereum", address: "0x876ceed4a83ef6bc219fd14c239a0f54895d4ada", artifacts: [ART.FlashLiquidateEulerEVK], searchRoot: "contracts/flash-liquidate-euler-evk/out" },
  { label: "EULER-LIQ-V3-2", chainId: 1, chain: "Ethereum", address: "0x22760de82a1ebf0c9467e8e15684a03b2fa8dd58", artifacts: [ART.FlashLiquidateEulerEVK], searchRoot: "contracts/flash-liquidate-euler-evk/out" },
  { label: "EULER-LIQ-V3-3", chainId: 1, chain: "Ethereum", address: "0xd2e340b1ce33453509d34e8a8eee63e67b442c29", artifacts: [ART.FlashLiquidateEulerEVK], searchRoot: "contracts/flash-liquidate-euler-evk/out" },
  { label: "EULER-LIQ-V3-F1", chainId: 1, chain: "Ethereum", address: "0xb3219646e7b93ddc6cb8e10d6d80782f42f758fa", artifacts: [ART.FlashLiquidateEulerEVK], searchRoot: "contracts/flash-liquidate-euler-evk/out" },
  { label: "EULER-LIQ-V3-F2", chainId: 1, chain: "Ethereum", address: "0xb6ae06b25bf329e02d8cafd168e38aafd0748f99", artifacts: [ART.FlashLiquidateEulerEVK], searchRoot: "contracts/flash-liquidate-euler-evk/out" },
  { label: "EULER-LIQ-V3-F3", chainId: 1, chain: "Ethereum", address: "0x45333d985c8338d14d1f0102d5e6fa6446aa669b", artifacts: [ART.FlashLiquidateEulerEVK], searchRoot: "contracts/flash-liquidate-euler-evk/out" },
  { label: "EULER-LIQ-V3-F4", chainId: 1, chain: "Ethereum", address: "0x308c3c7810c5ba1fb2a0831a6fc189014314b968", artifacts: [ART.FlashLiquidateEulerEVK], searchRoot: "contracts/flash-liquidate-euler-evk/out" },
  { label: "FLUID-T2T4", chainId: 1, chain: "Ethereum", address: "0x719ae473cdacaab7cebdc6b47b085123d5ead39c", artifacts: [ART.FltLiquidateT2T4], searchRoot: "contracts/flash-liquidate-fluid-t2t4/out" },
  { label: "E9", chainId: 1, chain: "Ethereum", address: "0x2cd636ccee97243688ddaa4b1f93b13f60d3a00f", artifacts: [ART.E9], searchRoot: "contracts/flash-liquidate-aave-v3/out", deployJson: "exploits/liquidation-bot/deploy.json" },
  { label: "E12x", chainId: 1, chain: "Ethereum", address: "0x492b15a4A93F74C8A027E69c91f2656AB5453c19", artifacts: [ART.E12x], searchRoot: "exploits/morpho-market-exploit/out", deployJson: "exploits/morpho-market-exploit/deploy.json" },
  { label: "E10/Base", chainId: 8453, chain: "Base", address: "0x4C8bDB2Bcdd7eAF55c2cd1dEb76c8b4174baC31F", artifacts: [ART.E10Base, ART.E10Generic], searchRoot: "exploits/cross-chain-oracle/out", deployJson: "exploits/cross-chain-oracle/deploy.base.json" },
  { label: "E10/Optimism", chainId: 10, chain: "Optimism", address: "0x08500266c4F40Ed80DEda53cD71204b8965541aE", artifacts: [ART.E10Generic, ART.E10Base], searchRoot: "exploits/cross-chain-oracle/out", deployJson: "exploits/cross-chain-oracle/deploy.optimism.json" },
  { label: "E10/Arbitrum", chainId: 42161, chain: "Arbitrum", address: "0x08500266c4F40Ed80DEda53cD71204b8965541aE", artifacts: [ART.E10Generic, ART.E10Base], searchRoot: "exploits/cross-chain-oracle/out", deployJson: "exploits/cross-chain-oracle/deploy.arbitrum.json" },
  { label: "E10/Polygon", chainId: 137, chain: "Polygon", address: "0xF9EBbDd6715C7fb53aA7ADe99d20A898FC95E178", artifacts: [ART.E10Generic, ART.E10Base], searchRoot: "exploits/cross-chain-oracle/out", deployJson: "exploits/cross-chain-oracle/deploy.polygon.json" },
];

function sha256Hex(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return "0x" + crypto.createHash("sha256").update(Buffer.from(clean, "hex")).digest("hex");
}

function isEvenHex(hexNoPrefix) {
  return hexNoPrefix.length % 2 === 0 && /^[0-9a-f]*$/i.test(hexNoPrefix);
}

function byteLen(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Math.floor(clean.length / 2);
}

function base58Encode(buffer) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of buffer) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let encoded = "";
  for (const byte of buffer) {
    if (byte === 0) encoded += alphabet[0];
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) encoded += alphabet[digits[i]];
  return encoded;
}

function loadRpcUrls() {
  const text = fs.readFileSync(RPC_FILE, "utf8");
  return [...text.matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    return json.result || null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRpcPool(chainIds) {
  const urls = loadRpcUrls();
  const wanted = new Set(chainIds);
  const pool = new Map();
  for (const url of urls) {
    if (pool.size === wanted.size) break;
    const idHex = await rpcCall(url, "eth_chainId", [], 8_000);
    if (!idHex) continue;
    const chainId = parseInt(idHex, 16);
    if (wanted.has(chainId) && !pool.has(chainId)) pool.set(chainId, url);
  }
  return pool;
}

async function getPinnedBlock(rpc) {
  const numberHex = await rpcCall(rpc, "eth_blockNumber", [], 10_000);
  if (!numberHex) return null;
  const block = await rpcCall(rpc, "eth_getBlockByNumber", [numberHex, false], 10_000);
  return {
    numberHex,
    number: parseInt(numberHex, 16),
    hash: block?.hash || null,
  };
}

function loadArtifact(relPath) {
  const fullPath = path.join(WORKSPACE, relPath);
  const artifact = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  const creation = artifact.bytecode?.object || "0x";
  const runtime = artifact.deployedBytecode?.object || "0x";
  const immutableReferences = artifact.deployedBytecode?.immutableReferences || {};
  return { relPath, creation, runtime, immutableReferences };
}

function loadDeployTx(relPath) {
  if (!relPath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(WORKSPACE, relPath), "utf8"));
    if (!parsed.txHash || !/^0x[0-9a-f]{64}$/i.test(parsed.txHash)) return null;
    return { relPath, txHash: parsed.txHash, expectedAddress: parsed.address || null };
  } catch (_) {
    return null;
  }
}

function listArtifacts(relDir) {
  const root = path.join(WORKSPACE, relDir);
  const out = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith(".json")) out.push(path.relative(WORKSPACE, full).replace(/\\/g, "/"));
    }
  }
  try { walk(root); } catch (_) {}
  return out;
}

function immutableMask(immutableReferences) {
  const mask = new Set();
  for (const refs of Object.values(immutableReferences || {})) {
    for (const ref of refs) {
      for (let i = ref.start; i < ref.start + ref.length; i++) mask.add(i);
    }
  }
  return mask;
}

function metadataInfo(hexNoPrefix) {
  if (hexNoPrefix.length < 4) return { bytes: 0, valid: false, claimedBytes: 0 };
  const cborLen = parseInt(hexNoPrefix.slice(-4), 16);
  if (!Number.isFinite(cborLen) || cborLen <= 0) return { bytes: 0, valid: false, claimedBytes: 0 };
  const totalBytes = cborLen + 2;
  if (totalBytes * 2 > hexNoPrefix.length) return { bytes: 0, valid: false, claimedBytes: totalBytes };

  const metadataHex = hexNoPrefix.slice(-(totalBytes * 2), -4);
  const firstByte = parseInt(metadataHex.slice(0, 2), 16);
  const hasCborMapPrefix = firstByte >= 0xa0 && firstByte <= 0xbf;
  const hasSolidityKey = /(69706673|627a7a72|736f6c63)/i.test(metadataHex); // ipfs, bzzr, solc
  const valid = hasCborMapPrefix && hasSolidityKey;
  const ipfsMatch = metadataHex.match(/64697066735822([0-9a-f]{68})/i);
  const solcMatch = metadataHex.match(/64736f6c6343([0-9a-f]{6})/i);
  const solcVersion = solcMatch ? solcMatch[1].match(/../g).map((x) => parseInt(x, 16)).join(".") : null;
  return {
    bytes: valid ? totalBytes : 0,
    valid,
    claimedBytes: totalBytes,
    ipfsCid: ipfsMatch ? base58Encode(Buffer.from(ipfsMatch[1], "hex")) : null,
    solcVersion,
  };
}

function countUnmaskedDiffs(left, right, mask) {
  let unmaskedDiffBytes = 0;
  let firstUnmaskedDiffByte = null;
  const commonBytes = Math.min(left.length, right.length) / 2;
  for (let i = 0; i < commonBytes; i++) {
    if (mask.has(i)) continue;
    const a = left.slice(i * 2, i * 2 + 2);
    const b = right.slice(i * 2, i * 2 + 2);
    if (a !== b) {
      unmaskedDiffBytes++;
      if (firstUnmaskedDiffByte === null) firstUnmaskedDiffByte = i;
    }
  }
  return { unmaskedDiffBytes, firstUnmaskedDiffByte };
}

function compareRuntime(deployedCode, artifact) {
  const deployed = deployedCode.toLowerCase().replace(/^0x/, "");
  const expected = artifact.runtime.toLowerCase().replace(/^0x/, "");
  const deployedValidHex = isEvenHex(deployed);
  const artifactValidHex = isEvenHex(expected);
  if (!deployedValidHex || !artifactValidHex) {
    return {
      artifact: artifact.relPath,
      status: artifactValidHex ? "INVALID_DEPLOYED_BYTECODE" : "INVALID_ARTIFACT_BYTECODE",
      rawMatch: false,
      maskedMatch: false,
      logicMatch: false,
      deployedValidHex,
      artifactValidHex,
      deployedBytes: deployedValidHex ? byteLen(deployed) : null,
      artifactBytes: artifactValidHex ? byteLen(expected) : null,
      error: artifactValidHex ? "deployed bytecode is not even-length hex" : "artifact runtime bytecode is not even-length hex or contains link placeholders",
    };
  }
  const mask = immutableMask(artifact.immutableReferences);
  const lenMatch = deployed.length === expected.length;
  const rawMatch = lenMatch && deployed === expected;
  const { unmaskedDiffBytes, firstUnmaskedDiffByte } = countUnmaskedDiffs(deployed, expected, mask);
  const maskedMatch = lenMatch && unmaskedDiffBytes === 0;

  const deployedMetadata = metadataInfo(deployed);
  const artifactMetadata = metadataInfo(expected);
  const deployedMetadataBytes = deployedMetadata.bytes;
  const artifactMetadataBytes = artifactMetadata.bytes;
  const deployedCore = deployedMetadataBytes > 0 ? deployed.slice(0, -(deployedMetadataBytes * 2)) : deployed;
  const expectedCore = artifactMetadataBytes > 0 ? expected.slice(0, -(artifactMetadataBytes * 2)) : expected;
  const coreLenMatch = deployedCore.length === expectedCore.length;
  const coreDiff = countUnmaskedDiffs(deployedCore, expectedCore, mask);
  const logicMatch = coreLenMatch && coreDiff.unmaskedDiffBytes === 0;

  return {
    artifact: artifact.relPath,
    status: rawMatch ? "RAW_MATCH" : maskedMatch ? "MATCH_IMMUTABLES_MASKED" : logicMatch ? "MATCH_LOGIC_METADATA_DIFF" : "MISMATCH",
    rawMatch,
    maskedMatch,
    logicMatch,
    deployedBytes: byteLen(deployed),
    artifactBytes: byteLen(expected),
    deployedMetadataBytes,
    artifactMetadataBytes,
    deployedMetadataValid: deployedMetadata.valid,
    artifactMetadataValid: artifactMetadata.valid,
    deployedMetadataClaimedBytes: deployedMetadata.claimedBytes,
    artifactMetadataClaimedBytes: artifactMetadata.claimedBytes,
    deployedMetadataIpfsCid: deployedMetadata.ipfsCid,
    artifactMetadataIpfsCid: artifactMetadata.ipfsCid,
    deployedSolcVersion: deployedMetadata.solcVersion,
    artifactSolcVersion: artifactMetadata.solcVersion,
    deployedLogicBytes: byteLen(deployedCore),
    artifactLogicBytes: byteLen(expectedCore),
    maskedImmutableBytes: mask.size,
    unmaskedDiffBytes: lenMatch ? unmaskedDiffBytes : null,
    firstUnmaskedDiffByte: lenMatch ? firstUnmaskedDiffByte : null,
    unmaskedLogicDiffBytes: coreLenMatch ? coreDiff.unmaskedDiffBytes : null,
    firstUnmaskedLogicDiffByte: coreLenMatch ? coreDiff.firstUnmaskedDiffByte : null,
    deployedRuntimeHash: sha256Hex(deployed),
    artifactRuntimeHash: sha256Hex(expected),
    deployedLogicHash: sha256Hex(deployedCore),
    artifactLogicHash: sha256Hex(expectedCore),
  };
}

function compareCreationInput(txInput, artifact) {
  const input = (txInput || "0x").toLowerCase().replace(/^0x/, "");
  const creation = artifact.creation.toLowerCase().replace(/^0x/, "");
  const inputValidHex = isEvenHex(input);
  const artifactValidHex = isEvenHex(creation);
  if (!inputValidHex || !artifactValidHex || creation.length === 0) {
    return {
      artifact: artifact.relPath,
      status: artifactValidHex ? "INVALID_TX_INPUT" : "INVALID_CREATION_BYTECODE",
      inputBytes: inputValidHex ? byteLen(input) : null,
      artifactCreationBytes: artifactValidHex ? byteLen(creation) : null,
      constructorArgBytes: null,
      firstDiffByte: null,
    };
  }

  let firstDiffByte = null;
  const commonBytes = Math.min(input.length, creation.length) / 2;
  for (let i = 0; i < commonBytes; i++) {
    if (input.slice(i * 2, i * 2 + 2) !== creation.slice(i * 2, i * 2 + 2)) {
      firstDiffByte = i;
      break;
    }
  }

  const creationPrefixMatch = input.startsWith(creation);
  return {
    artifact: artifact.relPath,
    status: creationPrefixMatch ? "CREATION_PREFIX_MATCH" : "CREATION_MISMATCH",
    creationPrefixMatch,
    inputBytes: byteLen(input),
    artifactCreationBytes: byteLen(creation),
    constructorArgBytes: creationPrefixMatch ? byteLen(input) - byteLen(creation) : null,
    firstDiffByte,
    txInputHash: sha256Hex(input),
    artifactCreationHash: sha256Hex(creation),
  };
}

async function main() {
  const neededChains = [...new Set(TARGETS.map((t) => t.chainId))];
  const rpcPool = await resolveRpcPool(neededChains);
  const pinnedBlocks = new Map();
  const results = [];

  for (const target of TARGETS) {
    const rpc = rpcPool.get(target.chainId);
    const deployTx = loadDeployTx(target.deployJson);
    const targetAddress = deployTx?.expectedAddress || target.address;
    if (!rpc) {
      results.push({ ...target, address: targetAddress, status: "NO_RPC" });
      continue;
    }

    if (!pinnedBlocks.has(target.chainId)) pinnedBlocks.set(target.chainId, await getPinnedBlock(rpc));
    const pinnedBlock = pinnedBlocks.get(target.chainId);
    if (!pinnedBlock) {
      results.push({ ...target, address: targetAddress, status: "BLOCK_QUERY_FAILED" });
      continue;
    }

    const deployedCode = await rpcCall(rpc, "eth_getCode", [targetAddress, pinnedBlock.numberHex], 15_000);
    if (!deployedCode || deployedCode === "0x") {
      results.push({ ...target, address: targetAddress, blockNumber: pinnedBlock.number, blockHash: pinnedBlock.hash, status: deployedCode === "0x" ? "NO_CODE" : "CODE_QUERY_FAILED" });
      continue;
    }

    const comparisons = target.artifacts.map((artifactPath) => compareRuntime(deployedCode, loadArtifact(artifactPath)));
    let best = comparisons.find((c) => c.rawMatch) || comparisons.find((c) => c.maskedMatch) || comparisons.find((c) => c.logicMatch) || comparisons[0];
    let fallbackComparisons = [];
    let nearestLengthDeltas = [];

    let didFallbackSearch = false;
    if (!best.rawMatch && !best.maskedMatch && target.searchRoot) {
      didFallbackSearch = true;
      const selected = new Set(target.artifacts.map((a) => a.replace(/\\/g, "/")));
      const allArtifacts = listArtifacts(target.searchRoot).filter((a) => !selected.has(a));
      fallbackComparisons = allArtifacts.map((artifactPath) => {
        try { return compareRuntime(deployedCode, loadArtifact(artifactPath)); }
        catch (_) { return null; }
      }).filter(Boolean).filter((c) => c.artifactBytes > 0);

      const fallbackBest = fallbackComparisons.find((c) => c.rawMatch) || fallbackComparisons.find((c) => c.maskedMatch) || fallbackComparisons.find((c) => c.logicMatch);
      if (fallbackBest) {
        best = {
          ...fallbackBest,
          status: fallbackBest.rawMatch ? "RAW_MATCH_FALLBACK" : fallbackBest.maskedMatch ? "MATCH_IMMUTABLES_MASKED_FALLBACK" : "MATCH_LOGIC_METADATA_DIFF_FALLBACK",
        };
      }
      nearestLengthDeltas = fallbackComparisons
        .map((c) => ({ artifact: c.artifact, artifactBytes: c.artifactBytes, deltaBytes: Math.abs(c.artifactBytes - byteLen(deployedCode)) }))
        .sort((a, b) => a.deltaBytes - b.deltaBytes)
        .slice(0, 3);
    }

    let deploymentInput = null;
    if (deployTx) {
      const tx = await rpcCall(rpc, "eth_getTransactionByHash", [deployTx.txHash], 15_000);
      const receipt = await rpcCall(rpc, "eth_getTransactionReceipt", [deployTx.txHash], 15_000);
      const creationComparisons = tx?.input
        ? target.artifacts.map((artifactPath) => compareCreationInput(tx.input, loadArtifact(artifactPath)))
        : [];
      const creationBest = creationComparisons.find((c) => c.creationPrefixMatch) || creationComparisons[0] || null;
      deploymentInput = {
        deployJson: deployTx.relPath,
        txHash: deployTx.txHash,
        txFound: !!tx,
        receiptFound: !!receipt,
        txTo: tx?.to || null,
        receiptStatus: receipt?.status || null,
        receiptContractAddress: receipt?.contractAddress || null,
        expectedAddress: deployTx.expectedAddress,
        addressMatchesReceipt: receipt?.contractAddress ? receipt.contractAddress.toLowerCase() === targetAddress.toLowerCase() : null,
        status: creationBest?.status || "TX_INPUT_UNAVAILABLE",
        matchedArtifact: creationBest?.creationPrefixMatch ? creationBest.artifact : null,
        comparisons: creationComparisons,
      };
    }

    results.push({
      label: target.label,
      chain: target.chain,
      chainId: target.chainId,
      address: targetAddress,
      blockNumber: pinnedBlock.number,
      blockHash: pinnedBlock.hash,
      status: best.status,
      matchedArtifact: best.maskedMatch || best.rawMatch || best.logicMatch ? best.artifact : null,
      comparisons,
      fallbackSearched: didFallbackSearch,
      fallbackComparisons: fallbackComparisons.filter((c) => c.rawMatch || c.maskedMatch || c.logicMatch).slice(0, 5),
      nearestLengthDeltas,
      deploymentInput,
    });
  }

  const summary = {
    checkedAt: new Date().toISOString(),
    rpcChainsResolved: [...rpcPool.keys()].sort((a, b) => a - b),
    rpcBlocks: Object.fromEntries([...pinnedBlocks.entries()].map(([chainId, block]) => [chainId, block ? { number: block.number, hash: block.hash } : null])),
    total: results.length,
    rawMatches: results.filter((r) => r.status === "RAW_MATCH" || r.status === "RAW_MATCH_FALLBACK").length,
    immutableMaskedMatches: results.filter((r) => r.status === "MATCH_IMMUTABLES_MASKED" || r.status === "MATCH_IMMUTABLES_MASKED_FALLBACK").length,
    logicMetadataMatches: results.filter((r) => r.status === "MATCH_LOGIC_METADATA_DIFF" || r.status === "MATCH_LOGIC_METADATA_DIFF_FALLBACK").length,
    mismatches: results.filter((r) => r.status === "MISMATCH").length,
    missing: results.filter((r) => r.status === "NO_RPC" || r.status === "NO_CODE" || r.status === "CODE_QUERY_FAILED" || r.status === "BLOCK_QUERY_FAILED").length,
    invalidArtifacts: results.filter((r) => r.status === "INVALID_ARTIFACT_BYTECODE" || r.status === "INVALID_DEPLOYED_BYTECODE").length,
    deployInputsChecked: results.filter((r) => r.deploymentInput).length,
    deployInputMatches: results.filter((r) => r.deploymentInput?.status === "CREATION_PREFIX_MATCH").length,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({ summary, results }, null, 2));

  console.log("Deployed bytecode verification");
  console.log(`checked=${summary.total} raw=${summary.rawMatches} immutablesMasked=${summary.immutableMaskedMatches} logicMetadata=${summary.logicMetadataMatches} mismatches=${summary.mismatches} missing=${summary.missing} deployInputs=${summary.deployInputMatches}/${summary.deployInputsChecked}`);
  for (const r of results) {
    const artifact = r.matchedArtifact ? path.basename(path.dirname(r.matchedArtifact)) + "/" + path.basename(r.matchedArtifact) : "no artifact match";
    const deployInput = r.deploymentInput ? ` deployInput=${r.deploymentInput.status}` : "";
    console.log(`${r.label.padEnd(7)} ${r.chain.padEnd(9)} ${r.status.padEnd(25)} ${artifact}${deployInput}`);
  }
  console.log(`Report: ${path.relative(WORKSPACE, OUT_FILE)}`);
}

main().catch((e) => {
  console.error(`Verification failed: ${e.message}`);
  process.exit(1);
});
