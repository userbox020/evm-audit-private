#!/usr/bin/env node
"use strict";

// --check: build an unsigned PAXG v3 action draft from bound on-chain params.
// --write: publish only the unsigned draft to a fixed, ignored reports path.
const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("./node_modules/ethers");
const { rpcCall, resolveRpc } = require("./shared-rpc.js");
const { MARKET, BOT, MORPHO, buildActions } = require("./lib/paxg-exact-actions.js");
const MARKET_IF = new ethers.Interface([
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
]);

async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !["--check", "--write"].includes(mode)) {
    console.error("usage: node tools/build-paxg-v3-action-draft.js --check|--write");
    process.exitCode = 1;
    return;
  }
  const url = await resolveRpc(1, null, { capability: "read", timeoutMs: 12000 });
  if (!url) throw new Error("RPC_UNAVAILABLE");
  const chain = await rpcCall(url, "eth_chainId", [], 15000);
  if (chain !== "0x1") throw new Error("WRONG_CHAIN");
  const header = await rpcCall(url, "eth_getBlockByNumber", ["latest", false], 15000);
  if (!header || !header.number || !/^0x[0-9a-f]{64}$/iu.test(header.hash || "")) throw new Error("PIN_UNAVAILABLE");
  const raw = await rpcCall(url, "eth_call", [{ to: MORPHO, data: MARKET_IF.encodeFunctionData("idToMarketParams", [MARKET]) }, header.number], 15000);
  if (!raw) throw new Error("MARKET_UNAVAILABLE");
  const decoded = MARKET_IF.decodeFunctionResult("idToMarketParams", raw);
  const params = [decoded[0], decoded[1], decoded[2], decoded[3], decoded[4]];
  const actions = buildActions(params);
  const draft = {
    schema: "paxg-exact-actions-draft/v1", status: "UNSIGNED_NOT_EXECUTABLE",
    chainId: "1", accountRef: BOT, marketId: MARKET, pin: { block: Number(BigInt(header.number)), hash: header.hash },
    actions,
    gasCeiling: "480000", // Sum of per-action maximums; no fee or net guarantee.
    blockers: ["FRESH_LIQUIDITY_AND_ROUTE_REAL_PROOF", "FRESH_CONSERVATIVE_NET", "SIGNED_PRODUCTION_V3_BATCH", "CURRENT_TURN_KEY_ACCESS_GRANT"],
  };
  if (mode === "--write") {
    const output = path.join(__dirname, "..", "reports", "raw", "fast", "exploit-rearm-canary", "paxg-v3-action-draft.json");
    fs.writeFileSync(output, `${JSON.stringify(draft, null, 2)}\n`);
  }
  console.log(JSON.stringify({ status: draft.status, chainId: draft.chainId, block: draft.pin.block,
    actionCount: actions.length, gasCeiling: draft.gasCeiling, blockers: draft.blockers, wroteDraft: mode === "--write" }));
}
if (require.main === module) main().catch(() => { console.error("FAIL paxg-draft-check"); process.exitCode = 1; });
