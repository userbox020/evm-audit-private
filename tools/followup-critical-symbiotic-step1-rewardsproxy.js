"use strict";
// Read-only follow-ups: ProxyAdmin owner, block decimal, runtime-vs-verified-metadata hash comparison.
const crypto = require("node:crypto");
const { id } = require("ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc.js");

const PROXY_ADMIN = "0x54b724f15d8696c69f7557f3ea08854978789c5c";
const IMPL = "0xa73501536b35def71c3b68273f6faff83c01630f";
const sha256 = (h) => "0x" + crypto.createHash("sha256").update(Buffer.from(h.slice(2), "hex")).digest("hex");

async function main() {
  const endpoint = await resolveRpc(1, null, { maxCandidates: 8 });
  if (!endpoint) throw new Error("no-mainnet-endpoint");
  const block = await rpcCall(endpoint, "eth_getBlockByNumber", ["latest", false]);
  const sel = id("owner()").slice(0, 10);
  const owner = await rpcCall(endpoint, "eth_call", [{ to: PROXY_ADMIN, data: sel }, block.number]);
  console.log("BLOCK_NUMBER_DEC=" + BigInt(block.number).toString());
  console.log("BLOCK_HASH=" + block.hash);
  console.log("BLOCK_TIMESTAMP=" + BigInt(block.timestamp).toString());
  console.log("PROXY_ADMIN=" + PROXY_ADMIN);
  console.log("PROXY_ADMIN_OWNER=" + owner);

  const onchain = await rpcCall(endpoint, "eth_getCode", [IMPL, block.number]);
  console.log("IMPL_ONCHAIN_SHA256=" + sha256(onchain));
  console.log("IMPL_ONCHAIN_BYTES=" + (onchain.length - 2) / 2);
  try {
    const j = require("../reports/raw/fast/../../tools/../../targets/../reports/raw/fast/critical-symbiotic-vaultv2-named-deployment-step3.json");
    void j;
  } catch (_) { /* ignore */ }
  try {
    const fs = require("node:fs");
    const meta = JSON.parse(fs.readFileSync("C:/Users/MiPC/AppData/Local/Temp/opencode/symbiotic-step1/rewards-impl.json", "utf8"));
    const db = meta.deployed_bytecode || "";
    console.log("VERIFIED_METADATA_DEPLOYED_BYTECODE_BYTES=" + ((db.length - 2) / 2));
    console.log("VERIFIED_METADATA_DEPLOYED_BYTECODE_SHA256=" + sha256(db));
    console.log("RUNTIME_MATCH=" + (sha256(db) === sha256(onchain)));
  } catch (e) {
    console.log("METADATA_COMPARE_FAIL=" + e.message);
  }
}
main().catch((e) => { console.error("FAIL " + e.message); process.exit(1); });
