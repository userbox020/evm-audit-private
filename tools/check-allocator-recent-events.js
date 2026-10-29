#!/usr/bin/env node
const { ethers } = require("ethers");
const { resolveRpc, rpcCall } = require("./shared-rpc");
(async () => {
  const r = await resolveRpc(1);
  // Morpho public allocator and the steakEURCV market reallocate events
  const ALLOC = "0xfd32fA2ca22c76dD6E550706Ad913FC6CE91c75D";
  const REALLOC_SIG = "ReallocateTo(address,bytes32,uint256)";
  const REALLOC_TOPIC = ethers.id(REALLOC_SIG);
  const blk = await rpcCall(r, "eth_blockNumber", [], 8000);
  const bn = parseInt(blk, 16);
  const from = bn - 10000;
  console.error(`Scanning blocks ${from} to ${bn}`);
  const logs = await rpcCall(r, "eth_getLogs", [{
    address: ALLOC,
    topics: [REALLOC_TOPIC],
    fromBlock: "0x" + from.toString(16),
    toBlock: "0x" + bn.toString(16),
  }], 30000).catch(() => null);
  
  if (!logs || !logs.length) {
    console.log(JSON.stringify({ events: 0, msg: "No reallocate events in last 10000 blocks" }));
    return;
  }
  console.log(JSON.stringify({
    events: logs.length,
    blocks: logs.map(l => parseInt(l.blockNumber, 16)),
    gap: bn - Math.max(...logs.map(l => parseInt(l.blockNumber, 16))),
  }, null, 2));
})().catch(e => console.error(e.message));
