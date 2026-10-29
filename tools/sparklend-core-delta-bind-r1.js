// sparklend-core-delta-bind-r1.js
// Read-only, keyless live binding for the SparkLend core delta scan (Lane B1).
// Resolves an RPC via tools/shared-rpc.js (no endpoint values are ever printed
// or persisted). Performs minimal eth_call/eth_getCode/eth_getStorageAt reads
// against the SparkLend Ethereum Pool and records a machine artifact.
//
// Difference from the Aave-v3 approach: this does NOT fork, sign, or mutate.
// It only proves which of the scanned revision's deltas are LIVE by:
//   1. resolving the Pool proxy -> EIP-1967 impl;
//   2. probing the NEW view selector `getReservesCount()` (only present in the
//      Spark delta, absent from upstream Aave v3-core v1.19.2);
//   3. searching the deployed Pool impl bytecode for that selector;
//   4. searching for the Spark revert string `FLASHLOAN_INTO_BORROW_DEPRECATED`
//      (expected absent from the Pool impl when FlashLoanLogic is an external
//      library, present if the logic is embedded).
"use strict";

const fs = require("fs");
const path = require("path");
const { resolveRpc, rpcCall, getImpl } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const OUT_FILE = path.join(OUT_DIR, "sparklend-core-delta-bind-r1.json");

const CHAIN_ID = 1;
const POOL_PROXY = "0xC13e21B648A5Ee794902342038FF3aDAB66BE987";
const PAD = "0x02C3eA4e34C0cBd694D2adFa2c690EECbC1793eE";
// From targets/spark-address-registry/src/SparkLend.sol (library addresses).
const FLASH_LOAN_LOGIC = "0x7f44e1c1dE70059D7cc483378BEFeE2a030CE247";
const REGISTRY_POOL_IMPL = "0x5aE329203E00f76891094DcfedD5Aca082a50e1b";

// Manually computed selectors (keccak256 of the canonical signature, first 4 bytes).
// Verified below against an in-process keccak reference if available.
const SEL = {
  getReservesCount: "0x0a0d1b1e", // recomputed below to avoid drift
};

const DEPRECATED_STRING = "FLASHLOAN_INTO_BORROW_DEPRECATED";
const DEPRECATED_HEX = Buffer.from(DEPRECATED_STRING, "ascii").toString("hex");

function hexToBigInt(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-f]*$/i.test(hex) || hex === "0x") return null;
  return BigInt(hex);
}

function decodeUint(hex) {
  const v = hexToBigInt(hex);
  return v === null ? null : v.toString();
}

function decodeAddress(hex) {
  if (typeof hex !== "string" || hex.length < 42) return null;
  return "0x" + hex.slice(-40).toLowerCase();
}

// Minimal ABI decode for (uint256) and (uint256[] / address[]) head returns.
function decodeArrayLength(hex) {
  if (typeof hex !== "string" || hex.length < 130) return null;
  // Dynamic array return ABI: [offset(32)][length(32)][elements...]; length is word 2.
  const word2 = hex.slice(66, 130);
  return BigInt("0x" + word2).toString();
}

async function main() {
  const result = {
    schema: "sparklend-core-delta-bind-r1",
    generatedAt: new Date().toISOString(),
    lane: "B1",
    chainId: CHAIN_ID,
    mode: "read-only-keyless",
    fork: false,
    signing: false,
    broadcast: false,
    endpointsPrinted: false,
    targets: { poolProxy: POOL_PROXY, poolAddressesProvider: PAD },
    calls: {},
    bytecodeSearch: {},
    binding: {},
    errors: [],
  };

  const rpc = await resolveRpc(CHAIN_ID);
  if (!rpc) {
    result.errors.push("RPC_UNRESOLVED");
    result.binding = { poolImplResolved: false, getReservesCountLive: false };
    writeOut(result);
    return;
  }

  // Compute the real selector for getReservesCount() using ethers (no network).
  try {
    const { id } = require("./node_modules/ethers");
    const sig = "getReservesCount()";
    SEL.getReservesCount = id(sig).slice(0, 10);
    result.selectors = {
      getReservesCount: SEL.getReservesCount,
      poolRevision: id("POOL_REVISION()").slice(0, 10),
      getReservesList: id("getReservesList()").slice(0, 10),
    };
    SEL.poolRevision = result.selectors.poolRevision;
    SEL.getReservesList = result.selectors.getReservesList;
  } catch (e) {
    result.errors.push("SELECTOR_REF_UNAVAILABLE");
    // Fallback: keccak via ethers may be unavailable; leave computed constants.
  }

  const latest = await rpcCall(rpc, "eth_blockNumber", [], 8000);
  result.calls.blockNumber = typeof latest === "string" ? latest : null;

  const codeProxy = await rpcCall(rpc, "eth_getCode", [POOL_PROXY, "latest"], 10000);
  result.calls.poolProxyCodeBytes =
    typeof codeProxy === "string" && /^0x[0-9a-f]*$/i.test(codeProxy)
      ? Math.max(0, (codeProxy.length - 2) / 2)
      : null;

  const impl = await getImpl(rpc, POOL_PROXY, 10000);
  result.calls.poolImpl = impl ? impl.toLowerCase() : null;
  result.calls.matchesRegistryPoolImpl =
    !!impl && impl.toLowerCase() === REGISTRY_POOL_IMPL.toLowerCase();

  let implCode = null;
  if (impl) {
    implCode = await rpcCall(rpc, "eth_getCode", [impl, "latest"], 12000);
  }
  const implCodeOk = typeof implCode === "string" && /^0x[0-9a-f]*$/i.test(implCode);
  if (implCodeOk) {
    result.calls.poolImplCodeBytes = Math.max(0, (implCode.length - 2) / 2);
    const lower = implCode.toLowerCase();
    result.bytecodeSearch.implHasGetReservesCountSelector =
      lower.includes(SEL.getReservesCount.slice(2).toLowerCase());
    result.bytecodeSearch.implHasDeprecatedString =
      lower.includes(DEPRECATED_HEX.toLowerCase());
    result.bytecodeSearch.deprecatedStringAscii = DEPRECATED_STRING;
  } else {
    result.errors.push("IMPL_CODE_UNAVAILABLE");
  }

  // Delta #1 (FlashLoanLogic flashloan-into-borrow removal): FlashLoanLogic is
  // an external library. Bind it directly and prove the Pool impl links it.
  if (implCodeOk) {
    result.bytecodeSearch.implLinksFlashLoanLogic = implCode
      .toLowerCase()
      .includes(FLASH_LOAN_LOGIC.slice(2).toLowerCase());
  }
  const fllCode = await rpcCall(rpc, "eth_getCode", [FLASH_LOAN_LOGIC, "latest"], 12000);
  if (typeof fllCode === "string" && /^0x[0-9a-f]*$/i.test(fllCode)) {
    result.calls.flashLoanLogicCodeBytes = Math.max(0, (fllCode.length - 2) / 2);
    result.bytecodeSearch.flashLoanLogicHasDeprecatedString = fllCode
      .toLowerCase()
      .includes(DEPRECATED_HEX.toLowerCase());
  } else {
    result.errors.push("FLASH_LOAN_LOGIC_CODE_UNAVAILABLE");
  }

  // Live probes (one retry each; the resolved public RPC can be transiently busy).
  const callRetry = async (method, params, ms) => {
    let out = await rpcCall(rpc, method, params, ms);
    if (out === null) out = await rpcCall(rpc, method, params, ms);
    return out;
  };

  if (SEL.getReservesCount) {
    const r = await callRetry("eth_call", [{ to: POOL_PROXY, data: SEL.getReservesCount }, "latest"], 8000);
    result.calls.getReservesCountRaw = r;
    result.calls.getReservesCount = decodeUint(r);
  }
  const rl = await callRetry("eth_call", [{ to: POOL_PROXY, data: SEL.getReservesList }, "latest"], 12000);
  result.calls.getReservesListLength = decodeArrayLength(rl);
  const rev = await callRetry("eth_call", [{ to: POOL_PROXY, data: SEL.poolRevision }, "latest"], 8000);
  result.calls.poolRevision = decodeUint(rev);

  // Delta #1 (flashloan-into-borrow removal) lives in the external FlashLoanLogic
  // library. Resolve it by scanning the Pool impl for PUSH20 (0x73) operands and
  // probing each referenced address for the Spark-only revert string.
  if (implCodeOk) {
    const hex = implCode.toLowerCase().replace(/^0x/, "");
    const seen = new Set();
    const candidates = [];
    for (let i = 0; i + 42 <= hex.length; i += 2) {
      if (hex[i] === "7" && hex[i + 1] === "3") {
        const addr = hex.slice(i + 2, i + 42);
        if (!seen.has(addr)) {
          seen.add(addr);
          candidates.push(addr);
        }
      }
    }
    result.push20CandidateCount = candidates.length;
    const matches = [];
    for (const addr of candidates.slice(0, 48)) {
      const c = await callRetry("eth_getCode", ["0x" + addr, "latest"], 8000);
      if (typeof c === "string" && c.length > 2 && c.toLowerCase().includes(DEPRECATED_HEX.toLowerCase())) {
        matches.push("0x" + addr);
      }
    }
    result.bytecodeSearch.push20AddressesWithDeprecatedString = matches.slice(0, 8);
    result.bytecodeSearch.linkedFlashLoanLogicResolved = matches.length > 0;
  }

  result.binding = {
    rpcResolved: true,
    poolImplResolved: !!impl,
    matchesRegistryPoolImpl: !!result.calls.matchesRegistryPoolImpl,
    getReservesCountSelector: SEL.getReservesCount || null,
    getReservesCountLive:
      result.calls.getReservesCount !== null && result.calls.getReservesCount !== undefined,
    implBytecodeHasGetReservesCountSelector:
      !!result.bytecodeSearch.implHasGetReservesCountSelector,
    implBytecodeHasDeprecatedString: !!result.bytecodeSearch.implHasDeprecatedString,
    implLinksFlashLoanLogic: !!result.bytecodeSearch.implLinksFlashLoanLogic,
    flashLoanLogicHasDeprecatedString:
      !!result.bytecodeSearch.flashLoanLogicHasDeprecatedString,
    flashLoanLogicDeltaLiveBound: !!result.bytecodeSearch.linkedFlashLoanLogicResolved,
  };

  writeOut(result);
}

function writeOut(result) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2) + "\n", "utf8");
  } catch (e) {
    result.errors.push("WRITE_FAILED");
  }
  // Sanitized summary only; no endpoints or provider identities.
  const summary = {
    schema: result.schema,
    rpcResolved: !!result.binding.rpcResolved,
    poolImplResolved: !!result.binding.poolImplResolved,
    matchesRegistryPoolImpl: !!result.binding.matchesRegistryPoolImpl,
    getReservesCountLive: result.calls.getReservesCount ?? null,
    getReservesListLength: result.calls.getReservesListLength ?? null,
    poolRevision: result.calls.poolRevision ?? null,
    poolImplCodeBytes: result.calls.poolImplCodeBytes ?? null,
    flashLoanLogicCodeBytes: result.calls.flashLoanLogicCodeBytes ?? null,
    push20CandidateCount: result.push20CandidateCount ?? null,
    implHasGetReservesCountSelector: !!result.bytecodeSearch.implHasGetReservesCountSelector,
    implHasDeprecatedString: !!result.bytecodeSearch.implHasDeprecatedString,
    implLinksFlashLoanLogic: !!result.bytecodeSearch.implLinksFlashLoanLogic,
    flashLoanLogicHasDeprecatedString: !!result.bytecodeSearch.flashLoanLogicHasDeprecatedString,
    push20AddressesWithDeprecatedString:
      result.bytecodeSearch.push20AddressesWithDeprecatedString ?? [],
    linkedFlashLoanLogicResolved: !!result.bytecodeSearch.linkedFlashLoanLogicResolved,
    errors: result.errors,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
}
main().catch((e) => {
  const err = {
    schema: "sparklend-core-delta-bind-r1",
    fatal: true,
    error: String(e && e.message ? e.message : e).slice(0, 120),
  };
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(err, null, 2) + "\n", "utf8");
  } catch (_) {}
  process.stdout.write(JSON.stringify(err, null, 2) + "\n");
  process.exitCode = 1;
});
