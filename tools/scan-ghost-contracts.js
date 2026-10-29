#!/usr/bin/env node
// Read-only ghost/abandoned contract scanner.
// Finds contracts on Ethereum/Base/Arbitrum that hold significant value
// but are effectively dead: no recent activity, all functions dead/permission-gated.
// No signed actions. No private keys used.

const fs = require("fs");
const path = require("path");
const { resolveRpc, rpcCall, resolveRpcPool } = require("./shared-rpc");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const WORKSPACE = path.resolve(__dirname, "..");
const ARTIFACT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "recent-contracts-old-money.json");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "ghost-contracts.json");
const OUT_MD = path.join(WORKSPACE, "reports", "ghost-contracts.md");
const QUIET = process.argv.includes("--quiet");

const ETH_PRICE = 1575;
const TOKEN_PRICES = {
  WETH: 1575, USDC: 1, USDT: 1, WBTC: 63000, DAI: 1, wstETH: 1700, cbBTC: 63000,
};

// Token addresses by chainId
const CHAIN_TOKENS = {
  1: [
    { symbol: "WETH", address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", decimals: 18, price: 1575 },
    { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, price: 1 },
    { symbol: "USDT", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, price: 1 },
    { symbol: "WBTC", address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", decimals: 8, price: 63000 },
    { symbol: "DAI", address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, price: 1 },
    { symbol: "wstETH", address: "0x7f39C581F595B53c5cb19bD0b3f8dE6c935E2Ca0", decimals: 18, price: 1700 },
  ],
  8453: [
    { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", decimals: 18, price: 1575 },
    { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, price: 1 },
    { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, price: 63000 },
    { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, price: 1 },
    { symbol: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", decimals: 18, price: 1700 },
  ],
  42161: [
    { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18, price: 1575 },
    { symbol: "USDC", address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6, price: 1 },
    { symbol: "USDT", address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, price: 1 },
    { symbol: "WBTC", address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, price: 63000 },
    { symbol: "DAI", address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, price: 1 },
    { symbol: "wstETH", address: "0x5979D7b546E38E414F7E9822514be443A4800529", decimals: 18, price: 1700 },
  ],
};

const CHAIN_NAMES = { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum" };

// Hex constants
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3178ae13b2f9a72c40e25845b4de6f747db37a8e47b371062e";

// Selectors to probe
const PROBE_SELECTORS = [
  { sig: "withdraw(uint256)", selector: "0x2e1a7d4d", args: () => ["0x" + 1n.toString(16).padStart(64, "0")] },
  { sig: "claim()", selector: "0x4e71d92d", args: () => [] },
  { sig: "claim()", selector: "0x4e71e0d2", args: () => [] },
  { sig: "execute(address,uint256,bytes)", selector: "0xb61d27f6", args: () => ["0x000000000000000000000000000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000000000000000000000000001", "0x" + "00".repeat(32)] },
  { sig: "transfer(address,uint256)", selector: "0xa9059cbb", args: () => ["0x000000000000000000000000000000000000dEaD000000000000000000000000", "0x0000000000000000000000000000000000000000000000000000000000000001"] },
  { sig: "multicall(bytes[])", selector: "0xac9650d8", args: () => ["0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000"] },
];

const VIEW_PROBE_SELECTORS = [
  { sig: "owner()", selector: "0x8da5cb5b", args: () => [] },
  { sig: "admin()", selector: "0xf851a440", args: () => [] },
  { sig: "getOwners()", selector: "0xa0e67e2b", args: () => [] },
  { sig: "getThreshold()", selector: "0xe75235b8", args: () => [] },
  { sig: "totalSupply()", selector: "0x18160ddd", args: () => [] },
];

// Known live protocols — not ghosts despite role-gated/permissioned behavior
const KNOWN_LIVE = new Set([
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb".toLowerCase(), // Morpho Blue
  "0xc3d688B66703497DAA19211EEdff47f25384cdc3".toLowerCase(), // Compound cUSDCv3
  "0xA17581A9E3356d9A858b789D68B4d866e593aE94".toLowerCase(), // Compound cWETHv3
  "0xb125E6687d4313864e53df431d5425969c15Eb2F".toLowerCase(), // Compound Base cUSDCv3
  "0x46e6b214b524310239732D51387075E0e70970bf".toLowerCase(), // Compound Base cWETHv3
  "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC".toLowerCase(), // Arbitrum L1 ERC20 Gateway
  "0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a".toLowerCase(), // Arbitrum Bridge
  "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef".toLowerCase(), // Arbitrum L1 Gateway Router
]);

// Known bridge infrastructure — natural escrow/gateway contracts, not ghosts
const KNOWN_BRIDGES = new Set([
  "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC".toLowerCase(), // Arbitrum L1 ERC20 Gateway
  "0x8315177aB297bA92A06054cE80a67Ed4DBd7ed3a".toLowerCase(), // Arbitrum Bridge
  "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef".toLowerCase(), // Arbitrum L1 Gateway Router
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padHex(val, bytes = 32) {
  const s = typeof val === "bigint" ? val.toString(16) : BigInt(val).toString(16);
  return s.padStart(bytes * 2, "0");
}

function encodeArg(arg) {
  if (typeof arg === "string" && arg.startsWith("0x")) {
    // address or bytes — handle both
    const raw = arg.slice(2);
    if (raw.length <= 40) {
      // address
      return raw.padStart(64, "0");
    }
    // bytes — pad to next 32-byte boundary
    return raw.padEnd(Math.ceil(raw.length / 64) * 64, "0");
  }
  // bigint or number
  return padHex(BigInt(arg));
}

function buildCallData(selector, args) {
  let data = selector.replace("0x", "");
  for (const a of args) {
    data += encodeArg(a);
  }
  return "0x" + data;
}

async function ethCall(rpc, to, data, ms = 8000) {
  return rpcCall(rpc, "eth_call", [{ to, data }, "latest"], ms);
}

// ---------------------------------------------------------------------------
// Candidate list
// ---------------------------------------------------------------------------

const HARDCODED_CANDIDATES = [
  { address: "0x51C72848c68a965f66FA7a88855F9f7784502a7F", label: "FarmHeroGhost", chainId: 1 },
  { address: "0xBEE3211ab312a8D065c4FeF0247448e17A8da000", label: "BeeProxy", chainId: 1 },
  { address: "0xb0473CA01E91981623b65Daf84AB7Bc94a7e4000", label: "OKXProxy", chainId: 42161 },
];

function buildCandidateList() {
  const seen = new Set();
  const candidates = [];

  // Hardcoded candidates first
  for (const c of HARDCODED_CANDIDATES) {
    const key = `${c.chainId}:${c.address.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ ...c, address: c.address.toLowerCase() });
    }
  }

  // Read artifact
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(ARTIFACT_JSON, "utf8"));
  } catch {
    if (!QUIET) console.error("Warning: could not read artifact, continuing with hardcoded only");
    return candidates;
  }

  const topRows = artifact.topRows || [];
  for (const row of topRows) {
    const key = `${row.chainId}:${row.contract.toLowerCase()}`;
    if (seen.has(key)) continue;
    const val = row.currentBalanceUsd || 0;
    if (val < 50000) continue;
    seen.add(key);
    candidates.push({
      address: row.contract.toLowerCase(),
      label: row.contract.slice(0, 10) + "…",
      chainId: row.chainId,
      artifactValueUsd: val,
      artifactData: row,
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Contract scanning
// ---------------------------------------------------------------------------

async function scanContract(rpc, candidate) {
  const { address, label, chainId } = candidate;
  const tokens = CHAIN_TOKENS[chainId] || CHAIN_TOKENS[1];

  const result = {
    label,
    address,
    chain: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
    chainId,
    ethBalance: "0",
    ethBalanceUsd: 0,
    erc20Balances: {},
    erc20BalancesUsd: {},
    totalValueUsd: 0,
    codeBytes: 0,
    nonce: 0,
    isDeployed: false,
    implAddress: null,
    adminAddress: null,
    proxyAdminIsEoa: false,
    classification: "unknown",
    details: "",
    watchCandidate: false,
    probes: {},
    revertReasons: {},
  };

  // 1. ETH balance
  const ethBalRaw = await rpcCall(rpc, "eth_getBalance", [address, "latest"], 8000);
  if (ethBalRaw) {
    const ethWei = BigInt(ethBalRaw);
    result.ethBalance = etherValue(ethWei);
    result.ethBalanceUsd = Number(ethWei * BigInt(Math.round(ETH_PRICE * 1e18))) / 1e18 / 1e18;
  }

  // 2. Bytecode
  const codeRaw = await rpcCall(rpc, "eth_getCode", [address, "latest"], 8000);
  if (codeRaw && codeRaw !== "0x") {
    result.isDeployed = true;
    result.codeBytes = Buffer.from(codeRaw.slice(2), "hex").length;
  }

  // 3. Nonce (outgoing tx count)
  const nonceRaw = await rpcCall(rpc, "eth_getTransactionCount", [address, "latest"], 8000);
  if (nonceRaw !== null) {
    result.nonce = parseInt(nonceRaw, 16);
  }

  if (!result.isDeployed) {
    result.classification = "not-deployed";
    result.details = "No contract bytecode found at address";
    return result;
  }

  // 2b. Zero-code-bytes sanity check — catches token-holder-attribution errors
  // where we accidentally read the token contract's balanceOf instead of the holder
  if (result.codeBytes === 0) {
    result.classification = "eoa-or-destroyed";
    result.details = "Zero code bytes — likely an EOA or self-destructed contract";
    return result;
  }

  // 4. ERC20 balances
  for (const tok of tokens) {
    const data = buildCallData("0x70a08231", [address]); // balanceOf(address)
    const balRaw = await ethCall(rpc, tok.address, data, 6000);
    if (balRaw && balRaw !== "0x") {
      const bal = BigInt(balRaw);
      const display = bal / BigInt(10 ** Math.min(tok.decimals, 18));
      result.erc20Balances[tok.symbol] = display.toString();
      const usdVal = Number(bal * BigInt(Math.round(tok.price * 1e8)) / BigInt(10 ** Math.min(tok.decimals, 18))) / 1e8;
      result.erc20BalancesUsd[tok.symbol] = usdVal;
      result.totalValueUsd += usdVal;
    } else {
      result.erc20Balances[tok.symbol] = "0";
    }
  }
  result.totalValueUsd += result.ethBalanceUsd;

  // 5. EIP-1967 proxy detection
  const implRaw = await rpcCall(rpc, "eth_getStorageAt", [address, EIP1967_IMPL_SLOT, "latest"], 6000);
  if (implRaw && implRaw !== "0x" + "0".repeat(64)) {
    result.implAddress = "0x" + implRaw.slice(26);
  }

  const adminRaw = await rpcCall(rpc, "eth_getStorageAt", [address, EIP1967_ADMIN_SLOT, "latest"], 6000);
  if (adminRaw && adminRaw !== "0x" + "0".repeat(64)) {
    result.adminAddress = "0x" + adminRaw.slice(26);
    // Check if admin is EOA
    if (result.adminAddress && result.adminAddress !== ZERO_ADDR) {
      const adminCode = await rpcCall(rpc, "eth_getCode", [result.adminAddress, "latest"], 6000);
      if (adminCode === "0x" || !adminCode) {
        result.proxyAdminIsEoa = true;
      }
    }
  }

  // 6. Probe view functions
  for (const probe of VIEW_PROBE_SELECTORS) {
    const data = buildCallData(probe.selector, probe.args());
    const viewRaw = await ethCall(rpc, address, data, 6000);
    if (viewRaw !== null) {
      result.probes[probe.sig] = viewRaw;
    }
  }

  // 6b. For EIP-1967 proxies with function-based owner/admin, check if owner is EOA
  if (result.implAddress) {
    const ownerRaw = result.probes["owner()"];
    if (ownerRaw && ownerRaw !== "0x" && ownerRaw !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
      const fnOwnerAddr = "0x" + ownerRaw.slice(26);
      if (fnOwnerAddr !== (result.adminAddress || "").toLowerCase()) {
        const ownerCode = await rpcCall(rpc, "eth_getCode", [fnOwnerAddr, "latest"], 6000);
        if (ownerCode === "0x" || !ownerCode) {
          result.proxyAdminIsEoa = true;
          if (!result.adminAddress) result.adminAddress = fnOwnerAddr;
        }
      }
    }
    const adminFnRaw = result.probes["admin()"];
    if (!result.proxyAdminIsEoa && adminFnRaw && adminFnRaw !== "0x" && adminFnRaw !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
      const fnAdminAddr = "0x" + adminFnRaw.slice(26);
      const adminCode = await rpcCall(rpc, "eth_getCode", [fnAdminAddr, "latest"], 6000);
      if (adminCode === "0x" || !adminCode) {
        result.proxyAdminIsEoa = true;
        if (!result.adminAddress) result.adminAddress = fnAdminAddr;
      }
    }
  }

  // 7. Probe mutative functions — check revert behavior
  for (const probe of PROBE_SELECTORS) {
    const data = buildCallData(probe.selector, probe.args());
    const raw = await ethCall(rpc, address, data, 6000);
    if (raw !== null) {
      // Function did not revert — it executes
      result.probes[probe.sig] = raw;
    } else {
      // Function reverted — check for known error signatures
      result.revertReasons[probe.sig] = "reverted";
    }
  }

  // 8. Classification
  result.classification = classifyContract(result, candidate);

  // 8b. Override for known live protocols (not ghosts despite role-gated behavior)
  if (KNOWN_LIVE.has(result.address)) {
    result.classification = "known-live";
    result.details = "Known live protocol — expected role-gated/permissioned behavior";
    result.watchCandidate = false;
    return result;
  }

  // 8c. Override for known bridge infrastructure (natural escrow/gateway contracts)
  if (KNOWN_BRIDGES.has(result.address)) {
    result.classification = "bridge-infrastructure";
    result.details = "Known bridge/gateway — expected high-value escrow";
    result.watchCandidate = false;
    return result;
  }

  // 9. Watch candidate
  result.watchCandidate = ["dead-bytecode", "role-gated", "eip1967-proxy-with-eoa-owner", "abandoned-multisig"].includes(result.classification);

  return result;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyContract(result, candidate) {
  const { probes, revertReasons, implAddress, adminAddress, proxyAdminIsEoa, nonce, codeBytes } = result;
  const probeCount = Object.keys(probes).length;
  const revertCount = Object.keys(revertReasons).length;
  const totalProbes = PROBE_SELECTORS.length + VIEW_PROBE_SELECTORS.length;

  // Decode owner address from probes
  let ownerAddr = null;
  const ownerRaw = probes["owner()"];
  if (ownerRaw && ownerRaw !== "0x" && ownerRaw !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
    ownerAddr = "0x" + ownerRaw.slice(26);
  }
  const adminFnRaw = probes["admin()"];
  let adminFnAddr = null;
  if (adminFnRaw && adminFnRaw !== "0x" && adminFnRaw !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
    adminFnAddr = "0x" + adminFnRaw.slice(26);
  }

  // Check EIP-1967 proxy with EOA admin
  if (implAddress && proxyAdminIsEoa) {
    return "eip1967-proxy-with-eoa-owner";
  }

  // Check Gnosis Safe / abandoned multisig
  const hasOwners = probes["getOwners()"] && probes["getOwners()"] !== "0x" && probes["getOwners()"] !== "0x0000000000000000000000000000000000000000000000000000000000000000";
  const hasThreshold = probes["getThreshold()"] && probes["getThreshold()"] !== "0x";
  if (hasOwners || hasThreshold) {
    // Check if getOwners returns empty array
    if (probes["getOwners()"] === "0x" || probes["getOwners()"] === "0x0000000000000000000000000000000000000000000000000000000000000000") {
      return "abandoned-multisig";
    }
    // TODO: deeper check — decode owners array and check activity
    return "active"; // has owners, assume active
  }

  // Check dead-bytecode: all mutative probes revert
  const mutativeReverts = PROBE_SELECTORS.filter(p => revertReasons[p.sig]).length;
  const mutativeTotal = PROBE_SELECTORS.length;

  if (mutativeReverts === mutativeTotal) {
    // All mutative functions revert. Check if views work.
    const workingViews = VIEW_PROBE_SELECTORS.filter(p => probes[p.sig] && probes[p.sig] !== "0x").length;
    // If ALL probed functions (views + mutative) fail → dead bytecode
    if (workingViews === 0) {
      return "dead-bytecode";
    }
    // Views return values (code is alive, but state-changing is permission-gated)
    return "role-gated";
  }

  // Some functions don't revert — contract has a live surface
  if (probeCount > 0) {
    return "active";
  }

  return "unknown";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function etherValue(wei) {
  if (!wei || wei === 0n) return "0";
  const divisor = 10n ** 18n;
  const whole = wei / divisor;
  const frac = wei % divisor;
  const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${fracStr}`;
}

function shortAddr(addr) {
  if (!addr || addr === "0x0000000000000000000000000000000000000000") return "0x0…0";
  return addr.slice(0, 8) + "…" + addr.slice(-4);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const candidates = buildCandidateList();
  const chainIds = [...new Set(candidates.map(c => c.chainId))];

  if (!QUIET) console.error(`Resolving RPCs for chains: ${chainIds.join(", ")}...`);
  const rpcMap = await resolveRpcPool(chainIds);

  if (!QUIET) console.error(`Scanning ${candidates.length} candidate contracts...`);

  const rows = [];
  const summary = {
    contractsScanned: 0,
    deadBytecode: 0,
    roleGated: 0,
    proxyWithEoaOwner: 0,
    abandonedMultisig: 0,
    knownLive: 0,
    bridgeInfrastructure: 0,
    eoaOrDestroyed: 0,
    active: 0,
    unknown: 0,
    totalValueUsd: 0,
    watchCandidates: 0,
    routePositive: 0,
  };

  for (const candidate of candidates) {
    const rpc = rpcMap[candidate.chainId];
    if (!rpc) {
      if (!QUIET) console.error(`  SKIP ${candidate.label}: no RPC for chain ${candidate.chainId}`);
      continue;
    }

    if (!QUIET) console.error(`  Scan ${candidate.label} (${shortAddr(candidate.address)}) on ${CHAIN_NAMES[candidate.chainId] || candidate.chainId}...`);

    const row = await scanContract(rpc, candidate);
    rows.push(row);
    summary.contractsScanned++;

    switch (row.classification) {
      case "dead-bytecode": summary.deadBytecode++; break;
      case "role-gated": summary.roleGated++; break;
      case "eip1967-proxy-with-eoa-owner": summary.proxyWithEoaOwner++; break;
      case "abandoned-multisig": summary.abandonedMultisig++; break;
      case "known-live": summary.knownLive++; break;
      case "bridge-infrastructure": summary.bridgeInfrastructure++; break;
      case "eoa-or-destroyed": summary.eoaOrDestroyed++; break;
      case "active": summary.active++; break;
      default: summary.unknown++; break;
    }

    summary.totalValueUsd += row.totalValueUsd;
    if (row.watchCandidate) summary.watchCandidates++;
  }

  // Build output
  const output = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-ghost-contracts.js",
    scope: "Read-only ghost/abandoned contract value scanner",
    safety: {
      signedActions: false,
      routePositive: false,
      executableNow: false,
    },
    summary: {
      contractsScanned: summary.contractsScanned,
      deadBytecode: summary.deadBytecode,
      roleGated: summary.roleGated,
      proxyWithEoaOwner: summary.proxyWithEoaOwner,
      abandonedMultisig: summary.abandonedMultisig,
      knownLive: summary.knownLive,
      bridgeInfrastructure: summary.bridgeInfrastructure,
      eoaOrDestroyed: summary.eoaOrDestroyed,
      active: summary.active,
      unknown: summary.unknown,
      totalValueUsd: Math.round(summary.totalValueUsd),
      watchCandidates: summary.watchCandidates,
      routePositive: 0,
    },
    rows: rows.map(r => {
      // Decode owner from probes for output
      let ownerFromFn = null;
      const ownerRaw = r.probes && r.probes["owner()"];
      if (ownerRaw && ownerRaw !== "0x" && ownerRaw !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        ownerFromFn = "0x" + ownerRaw.slice(26);
      }
      let adminFromFn = null;
      const adminRaw = r.probes && r.probes["admin()"];
      if (adminRaw && adminRaw !== "0x" && adminRaw !== "0x0000000000000000000000000000000000000000000000000000000000000000") {
        adminFromFn = "0x" + adminRaw.slice(26);
      }
      return {
        label: r.label,
        address: r.address,
        chain: r.chain,
        chainId: r.chainId,
        ethBalance: r.ethBalance,
        erc20Balances: r.erc20Balances,
        totalValueUsd: Math.round(r.totalValueUsd),
        codeBytes: r.codeBytes,
        nonce: r.nonce,
        isEip1967Proxy: !!r.implAddress,
        implAddress: r.implAddress || null,
        adminSlotAddress: r.adminAddress || null,
        ownerFromFn: ownerFromFn,
        adminFromFn: adminFromFn,
        proxyAdminIsEoa: r.proxyAdminIsEoa,
        classification: r.classification,
        details: r.details,
        watchCandidate: r.watchCandidate,
      };
    }),
  };

  // Write JSON
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(output, null, 2));

  // Write Markdown
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  writeMarkdown(output, summary);

  // Console summary
  console.log(`\n=== Ghost Contract Scanner Results ===`);
  console.log(`Scanned: ${summary.contractsScanned}`);
  console.log(`  dead-bytecode:          ${summary.deadBytecode}`);
  console.log(`  role-gated:             ${summary.roleGated}`);
  console.log(`  proxy-with-eoa-owner:   ${summary.proxyWithEoaOwner}`);
  console.log(`  abandoned-multisig:     ${summary.abandonedMultisig}`);
  console.log(`  known-live (excluded):  ${summary.knownLive}`);
  console.log(`  bridge-infra (excluded): ${summary.bridgeInfrastructure}`);
  console.log(`  eoa-or-destroyed:       ${summary.eoaOrDestroyed}`);
  console.log(`  active:                 ${summary.active}`);
  console.log(`  unknown:                ${summary.unknown}`);
  console.log(`Total value held: $${Math.round(summary.totalValueUsd).toLocaleString()}`);
  console.log(`Watch candidates: ${summary.watchCandidates}`);
  console.log(`\nJSON: ${path.relative(WORKSPACE, OUT_JSON)}`);
  console.log(`MD:   ${path.relative(WORKSPACE, OUT_MD)}`);
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

function writeMarkdown(output, summary) {
  const lines = [];
  const dateStr = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";

  lines.push(`# Ghost / Abandoned Contract Scan`);
  lines.push("");
  lines.push(`**Generated**: ${dateStr}`);
  lines.push(`**Scanner**: \`tools/scan-ghost-contracts.js\``);
  lines.push("");
  lines.push("## Safety Gate");
  lines.push("");
  lines.push("| Property | Value |");
  lines.push("|---|---|");
  lines.push("| Signed actions | No");
  lines.push("| Route-positive | No");
  lines.push("| Executable now | No");
  lines.push("| Private keys used | No");
  lines.push("| RPC URLs stored | No");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Contracts scanned | ${summary.contractsScanned} |`);
  lines.push(`| Dead bytecode | ${summary.deadBytecode} |`);
  lines.push(`| Role-gated | ${summary.roleGated} |`);
  lines.push(`| Proxy with EOA owner | ${summary.proxyWithEoaOwner} |`);
  lines.push(`| Abandoned multisig | ${summary.abandonedMultisig} |`);
  lines.push(`| Known live (excluded) | ${summary.knownLive} |`);
  lines.push(`| Bridge infrastructure (excluded) | ${summary.bridgeInfrastructure} |`);
  lines.push(`| EOA / destroyed (excluded) | ${summary.eoaOrDestroyed} |`);
  lines.push(`| Active | ${summary.active} |`);
  lines.push(`| Unknown | ${summary.unknown} |`);
  lines.push(`| Total value held | $${Math.round(summary.totalValueUsd).toLocaleString()} |`);
  lines.push(`| Watch candidates | ${summary.watchCandidates} |`);
  lines.push("");
  lines.push("## Ghost Contract Rows");
  lines.push("");
  lines.push("| # | Label | Address | Chain | ETH | ERC20 Summary | Total USD | Code | Classification | Watch |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");

  let idx = 0;
  for (const r of output.rows) {
    idx++;
    const addr = shortAddr(r.address);
    const ercParts = Object.entries(r.erc20Balances).filter(([, v]) => v !== "0").map(([k, v]) => `${k}:${v}`);
    const ercSummary = ercParts.length > 0 ? ercParts.join(" ") : "—";
    const watch = r.watchCandidate ? "⚠️" : "—";
    lines.push(`| ${idx} | ${r.label} | \`${addr}\` | ${r.chain} | ${r.ethBalance} | ${ercSummary} | $${r.totalValueUsd.toLocaleString()} | ${r.codeBytes}B | ${r.classification} | ${watch} |`);
  }

  lines.push("");
  lines.push("## Classification Legend");
  lines.push("");
  lines.push("- **dead-bytecode**: All probed functions revert or return empty — contract is a zombie.");
  lines.push("- **role-gated**: Public functions exist but revert with permission errors (e.g. owner-only).");
  lines.push("- **eip1967-proxy-with-eoa-owner**: Upgradeable proxy whose admin is an EOA — single-point-of-failure risk.");
  lines.push("- **abandoned-multisig**: Looks like a multisig (Gnosis Safe selectors) but with no active owners.");
  lines.push("- **active**: Contract still has live public functions — not a ghost.");
  lines.push("");
  lines.push("## Watch List");
  lines.push("");
  lines.push("Contracts marked with ⚠️ are watch candidates — dead or permission-gated contracts holding significant value that may become exploitable if permissions change or critical bugs are discovered.");
  lines.push("");

  fs.writeFileSync(OUT_MD, lines.join("\n"));
}

// ---------------------------------------------------------------------------

main().catch(err => {
  console.error("FATAL:", err.message);
  process.exit(1);
});
