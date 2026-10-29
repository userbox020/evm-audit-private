#!/usr/bin/env node
// Read-only EVM perps margin consumer scanner.
// Checks if anomalous producer tokens appear as collateral/margin in
// known EVM perps protocols (GMX, Vertex, etc.).

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "perps-consumer-routes.json");
const QUIET = process.argv.includes("--quiet");

const TIMEOUT_MS = 15_000;

const FILES = {
  xstocksLive: path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-live.json"),
  hyperlaneWarp: path.join(WORKSPACE, "reports", "raw", "fast", "hyperlane-warp-routes.json"),
  erc4626Joiner: path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-consumer-joiner.json"),
};

const PERPS_PROTOCOLS = {
  42161: [
    {
      name: "GMX V2",
      type: "perps",
      contracts: [
        {
          address: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
          label: "DataStore",
          calls: [
            { method: "getAddressCount", sig: "getAddressCount(bytes32)", types: ["bytes32"] },
          ],
          keys: [
            { label: "MARKETS", value: ethers.keccak256(ethers.toUtf8Bytes("MARKETS")) },
          ],
        },
        {
          address: "0x5Ca0c6B50b2bC0f2ce3Adb9Db5Ae918B4FFb824E",
          label: "Reader",
          calls: [
            { method: "getMarkets", sig: "getMarkets(address,uint256,uint256)", types: ["address", "uint256", "uint256"] },
          ],
        },
      ],
    },
    {
      name: "Vertex",
      type: "perps",
      contracts: [
        {
          address: "0xbbEE07B3e8121227AfCFe1E2B82772246226128e",
          label: "Endpoint",
          calls: [
            { method: "getProducts", sig: "getProducts()", types: [] },
          ],
        },
      ],
    },
  ],
  10: [
    {
      name: "Synthetix Perps",
      type: "perps",
      contracts: [
        {
          address: "0xf272382cB3BE8982468bdDf371Fdb2edfE209f96",
          label: "PerpsMarketProxy",
          calls: [
            { method: "getMarkets", sig: "getMarkets()", types: [] },
            { method: "getAllMarkets", sig: "getAllMarkets()", types: [] },
          ],
        },
      ],
    },
  ],
  1: [
    {
      name: "GMX V1",
      type: "perps",
      contracts: [
        {
          address: "0x489ee077994B6658eAfA855C308275EAd8097C4A",
          label: "Vault",
          calls: [
            { method: "allWhitelistedTokensLength", sig: "allWhitelistedTokensLength()", types: [] },
            { method: "allWhitelistedTokens", sig: "allWhitelistedTokens(uint256)", types: ["uint256"] },
          ],
        },
      ],
    },
  ],
};

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[$,%\s,]/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function round(value, decimals = 2) {
  const n = asNumber(value);
  if (n === null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function lowerAddress(value) {
  const text = String(value || "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : null;
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcPool(chainIds) {
  const pool = {};
  for (const url of loadRpcUrls()) {
    try {
      const idHex = await rpcCall(url, "eth_chainId", [], 6000);
      const chainId = Number(BigInt(idHex));
      if (chainIds.includes(chainId) && !pool[chainId]) pool[chainId] = url;
    } catch (_) {}
  }
  return pool;
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function prodMeta() {
  const meta = {};
  const xstocks = readJson(FILES.xstocksLive, {});
  for (const tok of xstocks?.arbitrum?.tokens || []) {
    const addr = lowerAddress(tok?.token || tok?.meta?.address);
    if (!addr) continue;
    meta[addr] = {
      source: "xstocks-live",
      symbol: tok?.asset?.symbol || tok?.meta?.symbol || null,
      name: tok?.asset?.name || tok?.meta?.name || null,
      chainId: 42161,
    };
  }
  const hyperlane = readJson(FILES.hyperlaneWarp, {});
  for (const prod of hyperlane?.producers || []) {
    const addr = lowerAddress(prod?.address);
    if (!addr) continue;
    meta[addr] = {
      source: "hyperlane-warp-routes",
      symbol: prod?.symbol || null,
      name: prod?.name || null,
      chainId: prod?.chainId || null,
    };
  }
  const erc4626 = readJson(FILES.erc4626Joiner, {});
  for (const prod of erc4626?.inventory || []) {
    const addr = lowerAddress(prod?.address);
    if (!addr) continue;
    meta[addr] = {
      source: "erc4626-consumer-joiner",
      symbol: prod?.symbol || null,
      name: prod?.name || null,
      chainId: prod?.chainId || null,
    };
  }
  return meta;
}

function prodAddressSet(meta) {
  return new Set(Object.keys(meta));
}

async function main() {
  const meta = prodMeta();
  const producers = prodAddressSet(meta);

  const chainIds = Object.keys(PERPS_PROTOCOLS).map(Number);
  const rpcs = await resolveRpcPool(chainIds);

  const protocolResults = [];
  const matches = [];

  for (const [chainIdStr, protocols] of Object.entries(PERPS_PROTOCOLS)) {
    const chainId = Number(chainIdStr);
    const rpc = rpcs[chainId];
    if (!rpc) {
      for (const p of protocols) {
        protocolResults.push({ chainId, protocol: p.name, error: "noRpcForChain", contractsChecked: 0, tokensFound: 0, matches: 0 });
      }
      continue;
    }

    let provider;
    try {
      provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    } catch (err) {
      for (const p of protocols) {
        protocolResults.push({ chainId, protocol: p.name, error: "providerError", contractsChecked: 0, tokensFound: 0, matches: 0 });
      }
      continue;
    }

    for (const p of protocols) {
      const tokens = [];
      let errors = 0;

      for (const contractDef of p.contracts) {
        for (const callDef of contractDef.calls) {
          try {
            const iface = new ethers.Interface([`function ${callDef.sig}`]);
            let params = [];

            if (callDef.method === "getAddressCount") {
              params = [contractDef.keys?.[0]?.value || ethers.ZeroHash];
            } else if (callDef.method === "getMarkets") {
              params = [contractDef.address, 0, 200];
            } else if (callDef.method === "allWhitelistedTokensLength") {
              params = [];
            } else if (callDef.method === "allWhitelistedTokens") {
              for (let i = 0; i < 50; i++) {
                try {
                  const data = iface.encodeFunctionData(callDef.method, [i]);
                  const raw = await provider.call({ to: contractDef.address, data });
                  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["address"], raw);
                  if (decoded[0]) tokens.push(String(decoded[0]).toLowerCase());
                } catch (_) { break; }
              }
              continue;
            } else if (callDef.method === "getProducts") {
              params = [];
            } else if (callDef.method === "getAllMarkets") {
              params = [];
            }

            const data = iface.encodeFunctionData(callDef.method, params);
            const raw = await provider.call({ to: contractDef.address, data });

            if (callDef.method === "getAddressCount") {
              const count = Number(BigInt(raw));
              if (count > 0 && count <= 200) {
                for (let i = 0; i < count; i++) {
                  try {
                    const key = contractDef.keys?.[0]?.value || ethers.ZeroHash;
                    const addrIface = new ethers.Interface(["function getAddressesAt(bytes32,uint256,uint256) view returns (address[])"]);
                    const addrData = addrIface.encodeFunctionData("getAddressesAt", [key, i, i + 1]);
                    const addrRaw = await provider.call({ to: contractDef.address, data: addrData });
                    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], addrRaw);
                    for (const a of decoded[0] || []) tokens.push(String(a).toLowerCase());
                  } catch (_) {}
                }
              }
            } else if (callDef.method === "getProducts") {
              try {
                const decoded = ethers.AbiCoder.defaultAbiCoder().decode(["uint32[]"], raw);
                for (const pid of decoded[0] || []) {
                  tokens.push(String(pid));
                }
              } catch (_) {}
            } else if (callDef.method === "getMarkets") {
              try {
                const result = raw && raw !== "0x" ? ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], raw)[0] : [];
                for (const a of result || []) tokens.push(String(a).toLowerCase());
              } catch (_) {
                try {
                  const offset = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], raw)[0];
                } catch (__) {}
              }
            } else if (callDef.method === "getAllMarkets") {
              try {
                const result = ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], raw)[0];
                for (const a of result || []) tokens.push(String(a).toLowerCase());
              } catch (_) {}
            }
          } catch (err) {
            errors += 1;
          }
        }
      }

      const dedupedTokens = [...new Set(tokens)];
      const matched = dedupedTokens.filter((t) => producers.has(t));
      for (const addr of matched) {
        const info = meta[addr] || {};
        matches.push({
          chainId,
          protocol: p.name,
          token: addr,
          producerSymbol: info.symbol || null,
          producerName: info.name || null,
          producerSource: info.source || null,
          producerChainId: info.chainId || null,
        });
      }

      protocolResults.push({
        chainId,
        protocol: p.name,
        contractsChecked: p.contracts.length,
        tokensQueried: dedupedTokens.length,
        matches: matched.length,
        erc20Tokens: dedupedTokens.filter((t) => /^0x[a-f0-9]{40}$/.test(t)),
        errors,
      });
    }
  }

  const watchCandidates = matches;

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-perps-consumer-routes.js",
    scope: "Read-only EVM perps margin consumer discovery for anomalous producer tokens",
    inputs: Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, v])),
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: watchCandidates.length > 0,
      signedActionJustified: false,
    },
    perpsProtocols: PERPS_PROTOCOLS,
    chainsWithRpc: Object.keys(rpcs).map(Number),
    producerStats: {
      totalProducerAddresses: producers.size,
    },
    summary: {
      protocolsSearched: Object.values(PERPS_PROTOCOLS).reduce((s, p) => s + p.length, 0),
      protocolResults: protocolResults.length,
      totalTokensQueried: protocolResults.reduce((s, r) => s + (r.tokensQueried || 0), 0),
      totalErc20Tokens: protocolResults.reduce((s, r) => s + (r.erc20Tokens?.length || 0), 0),
      perpsMatches: matches.length,
      watchCandidates: watchCandidates.length,
      routePositive: 0,
      signedActionJustified: false,
      closedReason: watchCandidates.length
        ? "producer tokens found in perps margin lists but no exact economics or fork proof"
        : matches.length
          ? "matches found but below significance threshold"
          : "no anomalous producer token appears in currently scanned perps protocol asset lists",
    },
    protocolResults,
    matches: matches.slice(0, 100),
    watchCandidates: watchCandidates.slice(0, 50),
    requiredForRoutePositive: [
      "anomalous producer is accepted as perps collateral/margin",
      "perps leverage allows meaningful position size",
      "xStocks/producer-side anomaly is current and permissionless-impacting",
      "exact perps position/swap/liquidation economics are positive after fees/gas/slippage",
      "fork extraction proof",
    ],
    nextReadOnlyStep: watchCandidates.length
      ? "Exact-quote and fork-proof only matched perps tokens with material liquidity."
      : "Extend perps protocol coverage or reopen when producer-perps token overlap appears.",
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, jsonReplacer, 2) + "\n");

  if (!QUIET) {
    const matchedProtocols = protocolResults.filter((r) => (r.matches || 0) > 0);
    console.log(`Perps consumer: protocols=${protocolResults.length} tokens=${artifact.summary.totalErc20Tokens} matches=${matches.length} watch=${watchCandidates.length}`);
    if (protocolResults.some((r) => r.errors)) {
      console.log(`  query errors: ${protocolResults.filter((r) => (r.errors || 0) > 0).map((r) => `${r.protocol}=${r.errors}`).join(" ")}`);
    }
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
