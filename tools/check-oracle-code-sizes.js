#!/usr/bin/env node
const { resolveRpc, rpcCall } = require("./shared-rpc");
(async () => {
  const r = await resolveRpc(1);
  const oracles = [
    "0x874514c2CA3512258C5C8194A7234A06860B080B",
    "0x24Dc7441b3486094BcE4aA782C91B30B57BD9dD7",
    "0xA66a4F03Fd8031973f8C7718904ce32385f54E70",
    "0xFd465cb96e21b6fBb3DE242b638635D57Ae0Be1c",
    "0x62011dc01c0B9833C4E53e20456400e4EA4b8363",
    "0x1875a14c3e0cc539C1d3ECd4533928dE671651de",
    "0x270B2bD4CC6d935aa08b70eAC518E2907EB5588b",
    "0xcc90D7AfE71fBF17FD15846EBC0ab24b007a4A51",
    "0x3660c76f620d70B957B4CA190455126E89D6454b",
    "0xCB88FA5f48dc5751D82F20a3a4BA14803f827A73",
  ];
  const results = [];
  for (const o of oracles) {
    const code = await rpcCall(r, "eth_getCode", [o, "latest"], 8000).catch(() => "0x");
    const bytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;
    // Quick classification: check if it's a Chainlink aggregator (has decimals/description/latestRoundData)
    let type = bytes === 0 ? "no-code" : bytes <= 100 ? "minimal" : bytes <= 500 ? "small" : bytes <= 2000 ? "medium" : "large";
    // Check for Chainlink pattern: search for 'Chainlink' or aggregator bytecode
    const hasChainlink = code.includes("f599b40") || code.includes("5891a3c"); // partial 4byte selectors
    if (hasChainlink && bytes > 500) type = "chainlink-aggregator";
    results.push({ oracle: o.slice(0, 10), bytes, type });
  }
  console.log(JSON.stringify(results, null, 2));
})().catch(e => console.error(e.message));
