#!/usr/bin/env node
// probe-pricefeeds-live.js — Read Gravita + Prisma PriceFeed contracts on-chain
const fs = require("fs"); const path = require("path");
const { rpcCall, resolveRpc } = require("./shared-rpc");
const ethers = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ZERO = "0x0000000000000000000000000000000000000000";

// Function selectors
const SEL = {
  fetchPrice: "0xace1798e", // fetchPrice(address) — verified
  oracles: "0xaddd5099",    // oracles(address) — verified
  fallbacks: "0x26256c0b",  // fallbacks(address) — verified
  lastGoodPrice: "0x8429bbf6", // lastGoodPrice(address) — maybe Prisma
};

// Gravita PriceFeed
const GRAVITA_PF = "0x89F1ecCF2644902344db02788A790551Bb070351";

// Prisma PriceFeed
const PRISMA_PF = "0xc105ceacaed23cad3e9607666fef0b773bc86aac";

function encodeAddr(addr) { return "0".repeat(24) + addr.slice(2).toLowerCase(); }

async function callContract(rpc, to, data) {
  const raw = await rpcCall(rpc, "eth_call", [{ to, data }, "latest"], 8000);
  return raw;
}

function decodeOracleRecord(raw) {
  // OracleRecordV2 tuple: (address oracleAddress, uint8 providerType, uint256 timeoutSeconds, uint8 decimals, bool isEthIndexed)
  // ABI-encoded as: 5 slots (each 32 bytes) — but uint8/bool pack into 32 bytes each
  if (!raw || raw === "0x" || raw.length < 322) return null;
  // offset 0: oracleAddress (address, left-padded to 32 bytes)
  const oracleAddress = "0x" + raw.slice(26, 66);
  // offset 64: providerType
  const providerType = parseInt(raw.slice(130, 132), 16); // uint8 right-padded to 32 bytes → byte 31
  // offset 128: timeoutSeconds
  const timeoutSeconds = Number(BigInt("0x" + raw.slice(130, 194)));
  // offset 192: decimals
  const decimals = parseInt(raw.slice(258, 260), 16); // uint8
  // offset 256: isEthIndexed
  const isEthIndexed = raw.slice(322, 324) === "01";
  return { oracleAddress, providerType, timeoutSeconds, decimals, isEthIndexed };
}

async function probeGravita(rpc) {
  console.log("\n=== Gravita PriceFeed " + GRAVITA_PF.slice(0,10) + "... ===\n");

  for (const token of [{label:"WETH",addr:WETH},{label:"ETH(0x0)",addr:ZERO}]) {
    console.log("--- Token: " + token.label + " ---");

    // 1. Primary oracle
    const oracRaw = await callContract(rpc, GRAVITA_PF, SEL.oracles + encodeAddr(token.addr));
    const orac = decodeOracleRecord(oracRaw);
    if (orac && orac.oracleAddress !== ZERO) {
      const types = {0:"Chainlink",1:"API3",2:"Tellor"};
      console.log("  Primary: " + orac.oracleAddress.slice(0,10) + "... type=" + (types[orac.providerType]||orac.providerType) + " timeout=" + orac.timeoutSeconds + "s dec=" + orac.decimals + " ethIdx=" + orac.isEthIndexed);

      // Read actual oracle data
      if (orac.providerType === 0) {
        // Chainlink: latestRoundData
        const clRaw = await rpcCall(rpc, "eth_call", [{ to: orac.oracleAddress, data: "0xfeaf968c" }, "latest"], 5000);
        if (clRaw && clRaw.length >= 258) {
          const answer = BigInt("0x" + clRaw.slice(2 + 64, 2 + 128));
          const updatedAt = Number(BigInt("0x" + clRaw.slice(2 + 192, 2 + 256)));
          const age = Math.floor(Date.now()/1000) - updatedAt;
          console.log("    CL answer=" + Number(answer)/1e8 + " age=" + age + "s stale=" + (age > orac.timeoutSeconds ? "YES" : "no"));
        }
      } else if (orac.providerType === 1) {
        // API3: read()
        const api3Raw = await rpcCall(rpc, "eth_call", [{ to: orac.oracleAddress, data: "0x57de26a4" }, "latest"], 5000);
        if (api3Raw && api3Raw.length >= 130) {
          const value = BigInt("0x" + api3Raw.slice(2, 66));
          const timestamp = Number(BigInt("0x" + api3Raw.slice(66, 130)));
          const age = Math.floor(Date.now()/1000) - timestamp;
          console.log("    API3 value=" + Number(value)/1e18 + " age=" + age + "s stale=" + (age > orac.timeoutSeconds ? "YES" : "no"));
        }
      }
    }

    // 2. Fallback oracle
    const fbRaw = await callContract(rpc, GRAVITA_PF, SEL.fallbacks + encodeAddr(token.addr));
    const fb = decodeOracleRecord(fbRaw);
    if (fb && fb.oracleAddress !== ZERO) {
      const types = {0:"Chainlink",1:"API3",2:"Tellor"};
      console.log("  Fallback: " + fb.oracleAddress.slice(0,10) + "... type=" + (types[fb.providerType]||fb.providerType) + " timeout=" + fb.timeoutSeconds + "s dec=" + fb.decimals + " ethIdx=" + fb.isEthIndexed);
      if (fb.providerType === 0) {
        const clRaw = await rpcCall(rpc, "eth_call", [{ to: fb.oracleAddress, data: "0xfeaf968c" }, "latest"], 5000);
        if (clRaw && clRaw.length >= 258) {
          const answer = BigInt("0x" + clRaw.slice(2 + 64, 2 + 128));
          const updatedAt = Number(BigInt("0x" + clRaw.slice(2 + 192, 2 + 256)));
          const age = Math.floor(Date.now()/1000) - updatedAt;
          console.log("    CL answer=" + Number(answer)/1e8 + " age=" + age + "s stale=" + (age > fb.timeoutSeconds ? "YES" : "no"));
        }
      } else if (fb.providerType === 1) {
        const api3Raw = await rpcCall(rpc, "eth_call", [{ to: fb.oracleAddress, data: "0x57de26a4" }, "latest"], 5000);
        if (api3Raw && api3Raw.length >= 130) {
          const value = BigInt("0x" + api3Raw.slice(2, 66));
          const timestamp = Number(BigInt("0x" + api3Raw.slice(66, 130)));
          const age = Math.floor(Date.now()/1000) - timestamp;
          console.log("    API3 value=" + Number(value)/1e18 + " age=" + age + "s stale=" + (age > fb.timeoutSeconds ? "YES" : "no"));
        }
      }
    }

    // 3. Final price (fetchPrice)
    const fpRaw = await callContract(rpc, GRAVITA_PF, SEL.fetchPrice + encodeAddr(token.addr));
    if (fpRaw && fpRaw !== "0x" && fpRaw.length >= 66) {
      const price = Number(BigInt("0x" + fpRaw.slice(2, 66))) / 1e18;
      console.log("  fetchPrice: $" + price.toFixed(2));
    }
  }
}

async function probePrisma(rpc) {
  console.log("\n=== Prisma PriceFeed " + PRISMA_PF.slice(0,10) + "... ===\n");

  // Prisma PriceFeed — try standard functions
  // fetchPrice(address) — likely selector
  for (const token of [{label:"WETH",addr:WETH},{label:"ETH(0x0)",addr:ZERO}]) {
    const fpRaw = await callContract(rpc, PRISMA_PF, SEL.fetchPrice + encodeAddr(token.addr));
    if (fpRaw && fpRaw !== "0x" && fpRaw.length >= 66) {
      const price = Number(BigInt("0x" + fpRaw.slice(2, 66))) / 1e18;
      console.log("  fetchPrice(" + token.label + "): $" + price.toFixed(2));
    } else {
      console.log("  fetchPrice(" + token.label + "): no response");
    }
  }

  // Try fetchPrice (solidity overload maybe returns tuple)
  // Prisma might use a different interface — try some known selectors
  const PRISMA_SELECTORS = [
    { name:"lastGoodPrice", sig:SEL.lastGoodPrice },
    { name:"price", sig:"0xa035b1fe" },
    { name:"getPrice", sig:"0x41976e09" },
    { name:"PRISMA_CORE", sig:"0x87f44c91" },
  ];
  for (const s of PRISMA_SELECTORS) {
    const raw = await callContract(rpc, PRISMA_PF, s.sig + encodeAddr(WETH), 5000);
    if (raw && raw !== "0x" && raw.length >= 66) {
      const v = Number(BigInt("0x" + raw.slice(2, 66))) / 1e18;
      console.log("  " + s.name + "(WETH): " + (v > 100 ? "$" + v.toFixed(2) : v.toFixed(6)));
    }
  }
}

async function main() {
  console.log("=== Live PriceFeed Probe ===\n");
  const rpc = await resolveRpc(1);
  if (!rpc) { console.error("No ETH RPC"); return; }
  console.log("RPC: " + rpc.slice(0,40) + "...\n");

  await probeGravita(rpc);
  await probePrisma(rpc);

  console.log("\n=== Done ===");
}
main().catch(e => { console.error(e.message); process.exit(1); });
