#!/usr/bin/env node
// scan-vault-donation.js — ERC4626 Vault Donation Vulnerability Scanner
// BUILT AND MAINTAINED BY THIS WORKSPACE — DO NOT DUPLICATE OR MODIFY.
// Scans factory events for all vaults, checks totalAssets, flags donation-vulnerable vaults.
// Output: reports/monitor/vault-inventory.json
// Usage: node tools/scan-vault-donation.js
//        node tools/scan-vault-donation.js --quick  (last 10k blocks only)

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "monitor", "vault-inventory.json");

const RPC_TIMEOUT = 15_000;
const BATCH_SIZE = 20; // concurrent totalAssets checks

// ─── Verified Factory Addresses ─────────────────────────────────────────────
const FACTORIES = [
  {
    chainId: 1, name: "Morpho VaultV2Factory (Ethereum)",
    address: "0xA1D94F746dEfa1928926b84fB2596c06926C0405",
    deployTopic: "0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e",
    vaultInTopics: 3,
    fromBlock: 20000000,
  },
  {
    chainId: 8453, name: "Morpho VaultV2Factory (Base)",
    address: "0x4501125508079A99ebBebCE205DeC9593C2b5857",
    deployTopic: "0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e",
    vaultInTopics: 3,
    fromBlock: 44000000,
  },
];

// ─── Alert Thresholds ───────────────────────────────────────────────────────
const THRESHOLDS = {
  ZERO_ASSETS:  { max: 0,       severity: "CRITICAL", label: "ZERO_ASSETS" },
  LOW_TVL:      { max: 10_000,  severity: "HIGH",     label: "LOW_TVL" },
  MEDIUM_TVL:   { max: 100_000, severity: "MEDIUM",   label: "MEDIUM_TVL" },
};

// ─── Utility ────────────────────────────────────────────────────────────────
function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map(m => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    return (await res.json()).result ?? null;
  } catch (_) { return null; }
  finally { clearTimeout(t); }
}

async function resolveRpc(chainId) {
  const urls = extractRpcUrls();
  for (const u of urls) {
    const id = await rpcCall(u, "eth_chainId", [], 8000);
    if (id && parseInt(id, 16) === chainId) return u;
  }
  return null;
}

function decodeAddress(w) {
  if (!w || w.length < 66) return null;
  return "0x" + w.slice(-40);
}

function uint256(w) { try { return BigInt("0x" + (w || "0")); } catch { return 0n; } }

// ─── Scan All Events ────────────────────────────────────────────────────────

async function scanFactoryEvents(rpc, factory) {
  const vaults = [];
  let fromBlock = factory.fromBlock;
  console.log(`  Scanning from block ${fromBlock}...`);

  while (true) {
    // 10k block chunks
    const toBlock = fromBlock + 9999;
    const bnRes = await rpcCall(rpc, "eth_blockNumber", []);
    if (!bnRes) break;
    const currentBn = parseInt(bnRes, 16);
    if (fromBlock > currentBn) break;
    const effectiveTo = Math.min(toBlock, currentBn);

    try {
      const logs = await rpcCall(rpc, "eth_getLogs", [{
        address: factory.address,
        topics: [factory.deployTopic],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + effectiveTo.toString(16),
      }]);
      if (logs && logs.length > 0) {
        for (const l of logs) {
          const vaultAddr = decodeAddress(l.topics[factory.vaultInTopics]);
          if (!vaultAddr) continue;
          vaults.push({
            address: vaultAddr,
            deployBlock: parseInt(l.blockNumber, 16),
            deployTx: l.transactionHash,
          });
        }
      }
      const pct = ((effectiveTo - factory.fromBlock) / (currentBn - factory.fromBlock) * 100).toFixed(0);
      process.stdout.write(`\r  Block ${effectiveTo}/${currentBn} (${pct}%) — found ${vaults.length} vaults`);
    } catch (e) {
      process.stdout.write(`\n  Warning at ${fromBlock}: ${e.message}\n`);
    }

    fromBlock = effectiveTo + 1;
    if (fromBlock > currentBn || effectiveTo >= currentBn) break;
  }
  console.log("");
  return vaults;
}

// ─── Check totalAssets Batch ────────────────────────────────────────────────

async function checkVaultBatch(rpc, vaults) {
  const results = [];
  for (let i = 0; i < vaults.length; i += BATCH_SIZE) {
    const batch = vaults.slice(i, i + BATCH_SIZE);
    const checks = await Promise.all(batch.map(async (v) => {
      try {
        const [rawAssets, rawShareDecimals, rawAsset] = await Promise.all([
          rpcCall(rpc, "eth_call", [{ to: v.address, data: "0x01e1d114" }, "latest"]),
          rpcCall(rpc, "eth_call", [{ to: v.address, data: "0x313ce567" }, "latest"]).catch(() => null),
          rpcCall(rpc, "eth_call", [{ to: v.address, data: "0x38d52e0f" }, "latest"]).catch(() => null),
        ]);
        const shareDecimals = rawShareDecimals ? Number(uint256(rawShareDecimals.slice(2))) : 18;
        const asset = rawAsset ? decodeAddress(rawAsset) : null;
        const rawAssetDecimals = asset
          ? await rpcCall(rpc, "eth_call", [{ to: asset, data: "0x313ce567" }, "latest"]).catch(() => null)
          : null;
        const assetDecimals = rawAssetDecimals ? Number(uint256(rawAssetDecimals.slice(2))) : shareDecimals;
        let assets = rawAssets ? Number(uint256(rawAssets.slice(2))) / (10 ** assetDecimals) : 0;
        if (assets > 0 && assets < 0.01) assets = 0; // floor dust
        return { ...v, totalAssets: assets, decimals: shareDecimals, asset, assetDecimals };
      } catch (_) { return { ...v, totalAssets: null, decimals: 18, error: true }; }
    }));
    results.push(...checks);
    if (vaults.length > BATCH_SIZE) {
      process.stdout.write(`\r  Checked ${Math.min(i + BATCH_SIZE, vaults.length)}/${vaults.length} vaults`);
    }
  }
  if (vaults.length > BATCH_SIZE) console.log("");
  return results;
}

// ─── Classify ───────────────────────────────────────────────────────────────

function classify(totalAssets) {
  if (totalAssets === 0) return { flag: "ZERO_ASSETS", severity: "CRITICAL" };
  if (totalAssets < 10_000) return { flag: "LOW_TVL", severity: "HIGH" };
  if (totalAssets < 100_000) return { flag: "MEDIUM_TVL", severity: "MEDIUM" };
  return null;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const quickMode = process.argv.includes("--quick");
  console.log(quickMode ? "Quick scan (last 10k blocks per chain)" : "Full historical scan");

  const inventory = { scannedAt: new Date().toISOString(), chains: {} };

  for (const factory of FACTORIES) {
    console.log(`\nChain ${factory.chainId}: ${factory.name}`);
    const rpc = await resolveRpc(factory.chainId);
    if (!rpc) { console.log(`  No RPC found, skipping`); continue; }

    if (quickMode) {
      const bnRes = await rpcCall(rpc, "eth_blockNumber", []);
      if (bnRes) factory.fromBlock = Math.max(factory.fromBlock, parseInt(bnRes, 16) - 10000);
    }
    console.log(`  RPC resolved, scanning from ${factory.fromBlock}`);

    const vaults = await scanFactoryEvents(rpc, factory);
    if (vaults.length === 0) { console.log("  No vaults found\n"); continue; }

    console.log(`  Checking totalAssets for ${vaults.length} vaults...`);
    const enriched = await checkVaultBatch(rpc, vaults);

    const vulnerable = enriched.filter(v => v.totalAssets !== null && v.totalAssets < 100_000 && !v.error);
    const withError = enriched.filter(v => v.error);
    const counts = { ZERO_ASSETS: 0, LOW_TVL: 0, MEDIUM_TVL: 0, ERROR: withError.length };

    for (const v of vulnerable) {
      const c = classify(v.totalAssets);
      counts[c.flag] = (counts[c.flag] || 0) + 1;
    }
    console.log(`  Results: ${enriched.length} vaults | ZERO:${counts.ZERO_ASSETS} LOW:${counts.LOW_TVL} MEDIUM:${counts.MEDIUM_TVL} ERR:${counts.ERROR}`);

    inventory.chains[factory.chainId] = {
      factory: factory.name,
      factoryAddress: factory.address,
      total: enriched.length,
      vulnerable: vulnerable.length,
      errors: withError.length,
      vaults: enriched.map(v => ({
        address: v.address,
        deployBlock: v.deployBlock,
        totalAssets: v.totalAssets,
        decimals: v.decimals,
        asset: v.asset || null,
        assetDecimals: v.assetDecimals ?? null,
        flag: v.totalAssets !== null ? classify(v.totalAssets)?.flag || null : "ERROR",
      })),
    };
    console.log("");
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(inventory, null, 2));
  console.log(`Wrote inventory to ${path.relative(WORKSPACE, OUT)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
