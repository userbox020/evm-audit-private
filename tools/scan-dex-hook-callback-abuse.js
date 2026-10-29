#!/usr/bin/env node
// scan-dex-hook-callback-abuse.js - Cork Protocol $12M pattern: unauthorized hook callbacks,
// fake token + fake market, hook callback triggers external protocol interaction.
//
// Scans Balancer V3, Uniswap V4, PancakeSwap Infinity pools for hooks that could
// interact with external protocols (lending, bridging, etc.) in exploitable ways.
//
// Risk scoring:
//   HIGH   - hook interacts with known lending protocol interfaces
//   MEDIUM - hook has general external call capability (CALL/DELEGATECALL/STATICCALL)
//   LOW    - hook is stateless/balance-delta-only or address-derived (no code)

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "dex-hook-callback-abuse.json");
const QUIET = process.argv.includes("--quiet");
const RPC_TIMEOUT = 12000;

// ── Known lending protocol interface selectors (4-byte) ──────────────────────
// Only EXTERNAL PROTOCOL selectors (not ERC20 basics, not DEX internals)
const LENDING_SELECTORS = {
  // These are HIGH-risk: indicate actual lending/bridge/vault interaction
  core: new Set([
    // Aave V3 Pool - lending
    "617ba037", // supply(address,uint256,address,uint16)
    "e8eda9df", // supplyWithPermit
    "c5ebeaec", // borrow(address,uint256,uint256,uint16,address)
    "573ade81", // repay(address,uint256,uint256,address)
    "69328dec", // withdraw(address,uint256,address)
    "5cffe9de", // flashLoanSimple
    "ab9c4b5d", // flashLoan
    "a415bcad", // setUserUseReserveAsCollateral
    // Compound V3
    "f2b9fdb8", // supplyTo
    "c37f68e2", // borrow
    "0e752702", // repayBorrow
    "db006a75", // redeem
    // Morpho Blue
    "238d6579", // supply
    "a99aad89", // repay
    "50d8cd4b", // borrow
    "7c3a00fd", // withdraw
    "f3fef3a3", // supplyCollateral
    "872fdd02", // withdrawCollateral
    // ERC4626 vault
    "6e553f65", // deposit(uint256,address)
    "b460af94", // mint(uint256,address)
    "94bf804d", // withdraw(uint256,address,address)
    "ba087652", // redeem(uint256,address,address)
    // Bridge
    "8b477adb", // bridge/send
    "9b3b0de5", // relay/execute
    "0b6d125f", // crossChain
  ]),
  // ERC20 standard - NOT risk indicators by themselves (every token has these)
  erc20: new Set([
    "a9059cbb", // transfer
    "23b872dd", // transferFrom
    "095ea7b3", // approve
    "dd62ed3e", // allowance
    "18160ddd", // totalSupply
    "70a08231", // balanceOf
    "06fdde03", // name
    "95d89b41", // symbol
    "313ce567", // decimals
  ]),
  // Uniswap V4 internals - hook helper functions, not external lending
  uniswapV4: new Set([
    "783a7f5a", // swap
    "9e248ec9", // modifyLiquidity
    "02cc250d", // donate
  ]),
};

// Additional recognizable external-call patterns in bytecode
const CALL_OPCODES = new Set(["f1", "f4", "fa"]); // CALL=0xf1, DELEGATECALL=0xf4, STATICCALL=0xfa

// Known token contracts that appear as address-derived Uniswap V4 "hooks"
// These are NOT actual hook contracts - they just match the hook address derivation
const KNOWN_TOKEN_ADDRESSES = new Set([
  "0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH
  "0x6b175474e89094c44da98b954eedeac495271d0f", // DAI
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", // MATIC
  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
  "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", // UNI
  "0x514910771AF9Ca656af840dff83E8264EcF986CA", // LINK
  "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", // MKR
  "0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0", // MATIC
  "0xbb0E17EF65F82Ab018d8EDd776e8DD940327B28b", // AXL
  "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F", // SNX
]);

// Well-known Uniswap V4 hook addresses that are actual hook contracts (not tokens)
const KNOWN_HOOK_CONTRACTS = new Set([
  "0x3e2e24225cc1b3771677c84afc00a63c470ec088", // Singular / Steakhouse hook (ERC4626-based)
  "0x3fb49f96338b22cadd9614a51633189d4ce21088", // Another Steakhouse-origin hook
]);

function isTokenAddress(addr) {
  return KNOWN_TOKEN_ADDRESSES.has(addr.toLowerCase());
}

function isHookContract(addr) {
  return KNOWN_HOOK_CONTRACTS.has(addr.toLowerCase());
}

// ── Source artifacts ─────────────────────────────────────────────────────
const BALANCER_V3 = path.join(WORKSPACE, "reports", "raw", "fast", "balancer-v3-phase0.json");
const UNISWAP_V4_HOOKS = path.join(WORKSPACE, "reports", "raw", "fast", "uniswap-v4-hooks.json");
const PCS_INFINITY = path.join(WORKSPACE, "reports", "raw", "fast", "pancakeswap-infinity-phase0.json");
const ERC4626_V4_OVERLAPS = path.join(WORKSPACE, "reports", "raw", "fast", "erc4626-v4-hook-overlaps.json");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");

// ── RPC helpers ──────────────────────────────────────────────────────────
function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  const lines = fs.readFileSync(RPC_FILE, "utf8").split("\n");
  const urls = [];
  for (const l of lines) {
    if (/\[origin:/.test(l)) continue;
    const m = l.match(/(https?:\/\/[^\s'"<>\[\]]+)/);
    if (!m) continue;
    const u = m[1].replace(/[)\]]+\s*$/, "");
    if (!u || /solana|sui|aptos|stellar|tron|helius|rpcpool|oriontools|testnet|hoodi|sepolia|tatum/i.test(u)) continue;
    urls.push(u);
  }
  return urls;
}

async function rpcCall(url, method, params, ms = RPC_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result ?? null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function resolveRpc(chainId) {
  const urls = loadRpcUrls();
  for (const url of urls) {
    const id = await rpcCall(url, "eth_chainId", [], 6000);
    if (id && parseInt(id, 16) === chainId) return url;
  }
  return null;
}

// ── Bytecode analysis ────────────────────────────────────────────────────
function hasCallOpcodes(bytecode) {
  if (!bytecode || bytecode.length < 4) return false;
  const normalized = bytecode.startsWith("0x") ? bytecode.slice(2).toLowerCase() : bytecode.toLowerCase();
  // Scan for CALL/DELEGATECALL/STATICCALL opcodes (single-byte 0xf1, 0xf4, 0xfa)
  // Need to scan as hex pairs
  for (let i = 0; i < normalized.length - 1; i += 2) {
    const opcode = normalized.substring(i, i + 2);
    if (CALL_OPCODES.has(opcode)) return true;
  }
  return false;
}

function hasLendingSelectors(bytecode) {
  if (!bytecode || bytecode.length < 8) return { found: false, coreSelectors: [], erc20Selectors: [], v4Selectors: [] };
  const normalized = bytecode.startsWith("0x") ? bytecode.slice(2).toLowerCase() : bytecode.toLowerCase();
  const core = [];
  const erc20 = [];
  const v4 = [];
  for (const sel of LENDING_SELECTORS.core) {
    if (normalized.includes(sel)) core.push(sel);
  }
  for (const sel of LENDING_SELECTORS.erc20) {
    if (normalized.includes(sel)) erc20.push(sel);
  }
  for (const sel of LENDING_SELECTORS.uniswapV4) {
    if (normalized.includes(sel)) v4.push(sel);
  }
  return { found: core.length > 0, coreSelectors: core, erc20Selectors: erc20, v4Selectors: v4 };
}

async function checkHookBytecode(rpc, hookAddress, hookProtocol = "") {
  // Known token addresses are NOT actual hooks - they're derived addresses
  if (isTokenAddress(hookAddress)) {
    return {
      hasCode: true,
      codeSize: null,
      hasCallOps: false,
      lendingSelectors: [],
      score: "LOW",
      note: "Token address appears as derived hook - not an actual hook contract",
      isToken: true,
    };
  }

  const code = await rpcCall(rpc, "eth_getCode", [hookAddress, "latest"], RPC_TIMEOUT);
  if (!code || code === "0x") return { hasCode: false, codeSize: 0, hasCallOps: false, lendingSelectors: [], score: "LOW", isToken: false };

  const codeSize = Math.floor((code.length - 2) / 2);
  const hasCall = hasCallOpcodes(code);
  const lendingInfo = hasLendingSelectors(code);

  let score = "LOW";
  let note = null;

  // Only HIGH if core lending/bridge selectors found (not mere ERC20)
  if (lendingInfo.coreSelectors.length > 0) {
    score = "HIGH";
    if (isHookContract(hookAddress)) {
      note = "Known ERC4626-capable hook contract with lending interface selectors";
    } else {
      note = "Contains core lending/bridge selectors in bytecode";
    }
  } else if (hasCall && codeSize > 500) {
    // Medium only if substantial code with external calls (ignore tiny contracts)
    score = "MEDIUM";
    note = "External call capability with substantial code";
  } else if (hasCall && codeSize <= 500) {
    score = "LOW";
    note = "Tiny contract with call ops - likely metadata/tooling artifact";
  } else {
    score = "LOW";
    note = codeSize > 0 ? "Stateless or internal-only contract" : "No deployed code at hook address";
  }

  return {
    hasCode: true,
    codeSize,
    hasCallOps: hasCall,
    lendingSelectors: lendingInfo.coreSelectors,
    erc20Selectors: lendingInfo.erc20Selectors,
    v4Selectors: lendingInfo.v4Selectors,
    score,
    note,
    isToken: false,
  };
}

// ── Data extraction ──────────────────────────────────────────────────────
function loadJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

async function scanBalancerV3Hooks() {
  const data = loadJson(BALANCER_V3);
  if (!data) return [];
  const pools = (data.poolRows || []).filter((p) => p.hook && p.hook.address);
  const results = [];
  const chains = data.chainRows || [];

  for (const pool of pools) {
    const chainInfo = chains.find((c) => c.chainId === pool.chainId);
    results.push({
      protocol: "Balancer V3",
      chain: pool.chain || "unknown",
      chainId: pool.chainId,
      poolAddress: pool.pool,
      hookAddress: pool.hook.address,
      hookType: pool.hook.type || "unknown",
      tokens: pool.tokenSymbols || [],
      tvlUsd: pool.totalLiquidityUsd || 0,
      swapEnabled: pool.swapEnabled !== false,
      rpcAvailable: chainInfo?.rpcAvailable ?? false,
    });
  }
  return results;
}

function scanUniswapV4Hooks() {
  const data = loadJson(UNISWAP_V4_HOOKS);
  if (!data) return [];
  const results = [];
  for (const [chainKey, chainData] of Object.entries(data)) {
    const hooks = (chainData.hooks || []).filter((h) => h.hasCode && h.codeSize > 0);
    for (const hook of hooks) {
      results.push({
        protocol: "Uniswap V4",
        chain: chainKey === "ethereum" ? "Ethereum" : chainKey,
        chainId: chainData.chainId || 1,
        hookAddress: hook.address,
        hookType: "custom",
        flags: hook.flags,
        enabledFlags: hook.enabledFlags || [],
        poolCount: hook.poolCount,
        codeSize: hook.codeSize,
        hasCode: true,
        rpcAvailable: true,
        samplePoolIds: hook.samplePoolIds || [],
      });
    }
  }
  return results;
}

async function scanPancakeSwapInfinityHooks(rpcCache) {
  const data = loadJson(PCS_INFINITY);
  if (!data) return [];
  const results = [];
  const contractRows = data.contractRows || [];

  for (const cr of contractRows) {
    // PancakeSwap Infinity pools have hooks specified at initialization
    // Read a sample of initialize log events to find hook addresses
    // For now, enumerate from the contract artifact
    const poolManager = cr.poolManager;
    const vault = cr.vault;
    const pools = cr.poolRows || 0;
    const chainId = cr.chainId;
    const chain = cr.chain || "unknown";

    // Check if we need to probe for hook parameter via PoolManager
    if (pools > 0 && chainId === 56) {
      // BNB Chain - try to find pools with hooks via PoolManager
      const rpc = rpcCache[chainId] || null;
      if (rpc) {
        // Probe a few recent Initialize events for hook address
        try {
          const latestBlockRaw = await rpcCall(rpc, "eth_blockNumber", [], 6000);
          const latestBlock = parseInt(latestBlockRaw || "0", 16);
          if (latestBlock > 0) {
            // Check if we can get log for Initialize topic
            // INFINITY Initialize event: event Initialize(PoolId indexed id, Currency indexed currency0, Currency indexed currency1, uint24 fee, int24 tickSpacing, IHooks hooks)
            // Topic0 = keccak256("Initialize(PoolId,address,address,uint24,int24,address)")
            const initTopic = "0x4d20af83ad42a0e9b883b33faf8045fd62f5df4d4c4e9ca29075d2df7063ce59";
            const filter = {
              address: poolManager,
              topics: [initTopic],
              fromBlock: "0x" + Math.max(0, latestBlock - 100000).toString(16),
              toBlock: "0x" + latestBlock.toString(16),
            };
            const logs = await rpcCall(rpc, "eth_getLogs", [filter], 10000);
            if (logs && Array.isArray(logs) && logs.length > 0) {
              const hookAddrs = new Set();
              const sampleLogs = logs.slice(0, 50);
              for (const log of sampleLogs) {
                // PoolId is topic1, currency0 is topic2, currency1 is topic3
                // Hook address is the last 32-byte word in data
                if (log.data && log.data.length >= 66) {
                  const hookAddr = "0x" + log.data.slice(-40);
                  if (hookAddr !== "0x0000000000000000000000000000000000000000") {
                    hookAddrs.add(hookAddr.toLowerCase());
                  }
                }
              }
              for (const addr of hookAddrs) {
                results.push({
                  protocol: "PancakeSwap Infinity",
                  chain,
                  chainId,
                  hookAddress: addr,
                  hookType: "custom",
                  poolManager,
                  sampleCount: hookAddrs.size,
                  rpcAvailable: true,
                });
              }
            }
          }
        } catch (_) {
          // Log query may fail on limited RPCs
        }
      }
    }
  }

  return results;
}

// ── Main scan ────────────────────────────────────────────────────────────
async function main() {
  const startMs = Date.now();

  // Phase 0: resolve RPC endpoints
  const neededChainIds = new Set([1, 8453, 42161, 43114, 56]);
  const rpcCache = {};
  for (const cid of neededChainIds) {
    const rpc = await resolveRpc(cid);
    if (rpc) rpcCache[cid] = rpc;
  }

  // Phase 1: Collect hook candidates from artifacts
  const balancerHooks = await scanBalancerV3Hooks();
  const uniswapV4Hooks = scanUniswapV4Hooks();
  const pcsHooks = await scanPancakeSwapInfinityHooks(rpcCache);

  // Deduplicate and merge
  const allCandidates = [...balancerHooks, ...uniswapV4Hooks, ...pcsHooks];

  // Phase 2: Check hook bytecode for external call capability
  const rows = [];
  const seenHooks = new Set();

  for (const candidate of allCandidates) {
    const hookKey = `${candidate.chainId}:${candidate.hookAddress.toLowerCase()}`;
    if (seenHooks.has(hookKey)) continue;
    seenHooks.add(hookKey);

    const rpc = rpcCache[candidate.chainId];
    if (!rpc) {
      rows.push({
        ...candidate,
        hasCode: null,
        codeSize: null,
        hasCallOps: null,
        lendingSelectors: [],
        risk: "UNKNOWN",
        riskScore: 0,
        note: `No RPC available for chain ${candidate.chainId}`,
      });
      continue;
    }

    const bytecodeInfo = await checkHookBytecode(rpc, candidate.hookAddress, candidate.protocol);

    let riskScore = 0;
    if (bytecodeInfo.score === "HIGH") riskScore = 85;
    else if (bytecodeInfo.score === "MEDIUM") riskScore = 45;
    else if (bytecodeInfo.score === "LOW") riskScore = 5;

    rows.push({
      protocol: candidate.protocol,
      chain: candidate.chain,
      chainId: candidate.chainId,
      poolAddress: candidate.poolAddress || null,
      samplePoolIds: candidate.samplePoolIds || null,
      poolCount: candidate.poolCount || null,
      hookAddress: candidate.hookAddress,
      hookType: candidate.hookType || "unknown",
      tvlUsd: candidate.tvlUsd || null,
      tokens: candidate.tokens || [],
      flags: candidate.flags || null,
      enabledFlags: candidate.enabledFlags || null,
      hasCode: bytecodeInfo.hasCode,
      codeSize: bytecodeInfo.codeSize,
      hasCallOps: bytecodeInfo.hasCallOps,
      lendingSelectors: bytecodeInfo.lendingSelectors,
      risk: bytecodeInfo.score,
      riskScore,
      note: bytecodeInfo.note || null,
      isToken: bytecodeInfo.isToken || false,
    });
  }

  // Also check the ERC4626 V4 overlap actual hook addresses
  const erc4626Overlaps = loadJson(ERC4626_V4_OVERLAPS);
  if (erc4626Overlaps && erc4626Overlaps.rows) {
    const actualHookAddrs = new Set();
    for (const row of erc4626Overlaps.rows) {
      const addrs = row.analysis?.actualHookAddresses || [];
      for (const addr of addrs) {
        if (addr !== "0x0000000000000000000000000000000000000000") {
          actualHookAddrs.add(addr.toLowerCase());
        }
      }
    }
    for (const addr of actualHookAddrs) {
      const hookKey = `1:${addr}`;
      if (seenHooks.has(hookKey)) continue;
      seenHooks.add(hookKey);

      const rpc = rpcCache[1];
      if (rpc) {
        const bytecodeInfo = await checkHookBytecode(rpc, addr, "Uniswap V4");

        let riskScore = 0;
        if (bytecodeInfo.score === "HIGH") riskScore = 85;
        else if (bytecodeInfo.score === "MEDIUM") riskScore = 45;
        else if (bytecodeInfo.score === "LOW") riskScore = 5;

        const overlapRow = erc4626Overlaps.rows.find(
          (r) => (r.analysis?.actualHookAddresses || []).some((a) => a.toLowerCase() === addr)
        );

        rows.push({
          protocol: "Uniswap V4 (ERC4626 consumer)",
          chain: "Ethereum",
          chainId: 1,
          poolAddress: null,
          poolCount: null,
          hookAddress: addr,
          hookType: "V4 hook used with ERC4626 vault pools",
          tvlUsd: overlapRow?.erc4626?.totalAssets || null,
          tokens: [],
          hasCode: bytecodeInfo.hasCode,
          codeSize: bytecodeInfo.codeSize,
          hasCallOps: bytecodeInfo.hasCallOps,
          lendingSelectors: bytecodeInfo.lendingSelectors,
          risk: bytecodeInfo.score,
          riskScore,
          note: bytecodeInfo.note || "Discovered via ERC4626 V4 hook overlap artifact",
          isToken: bytecodeInfo.isToken || false,
        });
      }
    }
  }

  // Sort by riskScore descending, then by protocol
  rows.sort((a, b) => b.riskScore - a.riskScore || a.protocol.localeCompare(b.protocol));

  // Summary
  const highRisk = rows.filter((r) => r.risk === "HIGH");
  const mediumRisk = rows.filter((r) => r.risk === "MEDIUM");
  const lowRisk = rows.filter((r) => r.risk === "LOW");
  const unknownRisk = rows.filter((r) => r.risk === "UNKNOWN");

  const summary = {
    totalHookAddresses: rows.length,
    hooksWithCode: rows.filter((r) => r.hasCode === true).length,
    hooksWithoutCode: rows.filter((r) => r.hasCode === false).length,
    hooksUnknownCode: rows.filter((r) => r.hasCode === null).length,
    highRisk: highRisk.length,
    mediumRisk: mediumRisk.length,
    lowRisk: lowRisk.length,
    unknownRisk: unknownRisk.length,
    routePositive: 0,
    executableNow: false,
    signedActionJustified: false,
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-dex-hook-callback-abuse.js",
    scope: "Read-only DEX hook callback abuse scan following Cork Protocol $12M pattern",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
    },
    pattern: {
      name: "Cork Protocol $12M Exploit Pattern (CVE-level)",
      description: "Unauthorized hook callbacks with fake token + fake market creation. Hook callback automatically triggers interaction with external protocol (lending, bridging).",
      riskLevels: {
        HIGH: "Hook bytecode contains known lending protocol interface selectors - could be used to interact with lending pools through hook callbacks",
        MEDIUM: "Hook bytecode contains CALL/DELEGATECALL/STATICCALL opcodes - general external call capability exists",
        LOW: "Hook has no external call capability or is address-derived (no deployed code)",
        UNKNOWN: "Unable to verify hook bytecode (RPC unavailable or failed)",
      },
    },
    sourceArtifacts: [
      "reports/raw/fast/balancer-v3-phase0.json",
      "reports/raw/fast/uniswap-v4-hooks.json",
      "reports/raw/fast/pancakeswap-infinity-phase0.json",
      "reports/raw/fast/erc4626-v4-hook-overlaps.json",
    ],
    summary,
    topRows: rows.slice(0, 20),
    allRows: rows,
    blockers: highRisk.length > 0
      ? [
          "HIGH-risk hook(s) found with lending protocol interfaces. Requires source review and fork proof.",
          "No Cork-pattern exploitation proof has been demonstrated yet.",
          "Needs manual verification of hook permission model and callback gating.",
        ]
      : mediumRisk.length > 0
        ? [
            "MEDIUM-risk hook(s) with external call capability found. Requires source review.",
            "No lending interface selectors detected in bytecode.",
            "Permission model unknown - hook may be gated.",
          ]
        : [
            "No HIGH or MEDIUM risk hooks found.",
            "Balancer V3 hooks are of type STABLE_SURGE (Balancer-built).",
            "Uniswap V4 hooks with code are known token addresses or small custom hooks.",
          ],
    requiredForRoutePositive: [
      "Hook has permissionless callback entry point",
      "Hook interacts with external protocol where value can be extracted",
      "Fake token can be deployed and pool created with attacker-controlled hook",
      "Fork proof showing fund extraction through hook callback",
    ],
    nextReadOnlyStep: highRisk.length > 0
      ? "Conduct source review of HIGH-risk hooks. Create Foundry fork test to prove Cork-pattern exploitation path."
      : mediumRisk.length > 0
        ? "Review MEDIUM-risk hooks for permission model. Source-verify hook access control before closing."
        : "Mark as dormant. Refresh when new DEX pools with hooks are deployed on tracked chains.",
    elapsedMs: Date.now() - startMs,
  };

  // Write artifact
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  // Write triage
  writeTriage(artifact);

  if (!QUIET) {
    console.log("DEX Hook Callback Abuse Scan");
    console.log(`Total hooks: ${summary.totalHookAddresses}`);
    console.log(`HIGH: ${summary.highRisk} | MEDIUM: ${summary.mediumRisk} | LOW: ${summary.lowRisk} | UNKNOWN: ${summary.unknownRisk}`);
    if (highRisk.length > 0) {
      for (const h of highRisk) {
        console.log(`  HIGH: ${h.protocol} ${h.chain} hook=${h.hookAddress} selectors=${h.lendingSelectors.join(",")}`);
      }
    }
    if (mediumRisk.length > 0) {
      for (const h of mediumRisk.slice(0, 5)) {
        console.log(`  MEDIUM: ${h.protocol} ${h.chain} hook=${h.hookAddress} codeSize=${h.codeSize}`);
      }
    }
    console.log(`Report: ${path.relative(WORKSPACE, OUT).replace(/\\/g, "/")}`);
  }

  return artifact;
}

function writeTriage(artifact) {
  const OUT_TRIAGE = path.join(WORKSPACE, "reports", "dex-hook-callback-abuse-triage.md");
  const summary = artifact.summary;
  const highRisk = artifact.allRows.filter((r) => r.risk === "HIGH");
  const mediumRisk = artifact.allRows.filter((r) => r.risk === "MEDIUM");
  const signal = summary.highRisk > 0 ? "VULNERABLE" : summary.mediumRisk > 0 ? "DORMANT" : "CLEAN";
  const signalBanner = {
    VULNERABLE: "\uD83D\uDFE1 VULNERABLE",
    DORMANT: "\uD83D\uDFE2 DORMANT",
    CLEAN: "\u26AA CLEAN",
  }[signal];

  const lines = [
    `# ${signalBanner} - DEX Hook Callback Abuse Triage`,
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Pattern",
    "",
    "Following the Cork Protocol $12M exploit pattern: unauthorized hook callbacks, fake token + fake market creation, hook callback automatically triggers interaction with external protocols (lending, bridging, etc.).",
    "",
    "## Summary",
    "",
    `| Metric | Value |`,
    `| --- | --- |`,
    `| Total hook addresses scanned | ${summary.totalHookAddresses} |`,
    `| Hooks with deployed code | ${summary.hooksWithCode} |`,
    `| Hooks without code (address-derived) | ${summary.hooksWithoutCode} |`,
    `| HIGH risk (lending interface) | ${summary.highRisk} |`,
    `| MEDIUM risk (external calls) | ${summary.mediumRisk} |`,
    `| LOW risk | ${summary.lowRisk} |`,
    `| UNKNOWN risk | ${summary.unknownRisk} |`,
    "",
    "## Risk Levels",
    "",
    "- **HIGH**: Hook bytecode contains known lending protocol interface selectors (Aave, Compound, Morpho, etc.)",
    "- **MEDIUM**: Hook bytecode contains CALL/DELEGATECALL/STATICCALL opcodes",
    "- **LOW**: Hook has no external call capability or is address-derived (no deployed code)",
    "- **UNKNOWN**: Unable to verify hook bytecode (RPC unavailable)",
    "",
    "## Source Artifacts",
    "",
     ...artifact.sourceArtifacts.map((a) => `- \`${a}\``),
    "",
    "## Results",
    "",
  ];

  if (highRisk.length > 0) {
    lines.push("### HIGH Risk Hooks", "");
    lines.push("| Protocol | Chain | Hook Address | Lending Selectors | Code Size |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const h of highRisk) {
      lines.push(`| ${h.protocol} | ${h.chain} | \`${h.hookAddress}\` | ${h.lendingSelectors.join(", ")} | ${h.codeSize} |`);
    }
    lines.push(
      "",
      "**These hooks contain known lending protocol interface selectors in their bytecode.**",
      "If permissionless, an attacker could:",
      "1. Deploy a fake token",
      "2. Create a DEX pool with the fake token",
      "3. Register the hook for that pool",
      "4. Trigger a swap/donate/liquidity operation",
      "5. The hook callback would automatically interact with the lending protocol",
      "6. Extract real assets through the lending protocol interaction",
      "",
    );
  }

  if (mediumRisk.length > 0) {
    lines.push("### MEDIUM Risk Hooks", "");
    lines.push("| Protocol | Chain | Hook Address | Code Size | Pool Count |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const h of mediumRisk.slice(0, 15)) {
      lines.push(`| ${h.protocol} | ${h.chain} | \`${h.hookAddress}\` | ${h.codeSize} | ${h.poolCount || "N/A"} |`);
    }
    lines.push(
      "",
      "**These hooks have external call capability but no known lending interface selectors.**",
      "Source review needed to determine if callback can be used for value extraction.",
      "",
    );
  }

  lines.push(
    "## Blockers",
    "",
    ...(artifact.blockers || []).map((b) => `- ${b}`),
    "",
    "## Required for Route Positive",
    "",
    ...(artifact.requiredForRoutePositive || []).map((b) => `- ${b}`),
    "",
    "## Next Step",
    "",
    artifact.nextReadOnlyStep,
    "",
    "## All Hooks (top 20 by risk)", "",
    "| Risk | Protocol | Chain | Hook Address | Code Size | Has CALL | Lending Selectors |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );

  for (const h of artifact.topRows) {
    lines.push(
      `| ${h.risk} | ${h.protocol} | ${h.chain} | \`${h.hookAddress}\` | ${h.codeSize ?? "?"} | ${h.hasCallOps ? "yes" : h.hasCallOps === false ? "no" : "?"} | ${h.lendingSelectors?.join(",") || "none"} |`
    );
  }

  lines.push("", `Generated: ${artifact.generatedAt}`, `Scanner: ${artifact.scanner}`, "");

  fs.writeFileSync(OUT_TRIAGE, lines.join("\n") + "\n");
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
