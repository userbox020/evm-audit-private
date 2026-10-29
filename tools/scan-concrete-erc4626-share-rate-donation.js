#!/usr/bin/env node
// Read-only Concrete ERC4626 share-rate, first-depositor, donation-sensitivity, and downstream-acceptance sweep.
// Uses the refreshed Concrete prefilter and public RPCs via shared-rpc. No signed actions, no forks, no live mutation.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { resolveRpc } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const RAW_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const PREFILTER = path.join(RAW_DIR, "prefilter-concrete-route-prefilter.json");
const OUT = path.join(RAW_DIR, "concrete-erc4626-share-rate-donation.json");
const REPORT = path.join(WORKSPACE, "reports", "concrete-erc4626-share-rate-donation-triage.md");
const QUIET = process.argv.includes("--quiet");

const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256 assets)",
  "function convertToShares(uint256 assets) view returns (uint256 shares)",
  "function previewDeposit(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
  "function previewMint(uint256 shares) view returns (uint256 assets)",
  "function previewWithdraw(uint256 assets) view returns (uint256 shares)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function maxRedeem(address owner) view returns (uint256)",
]);
const DEAD = "0x000000000000000000000000000000000000dEaD";

function loadJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function units(value, decimals) { try { return Number(ethers.formatUnits(BigInt(value), decimals)); } catch { return null; } }
function bps(delta, base) { if (!base || !Number.isFinite(base) || base === 0 || !Number.isFinite(delta)) return null; return round((delta / base) * 10000, 4); }
function round(n, d = 4) { return Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null; }
function asBig(value) { try { return value === null || value === undefined ? null : BigInt(value); } catch { return null; } }

async function fetchCall(provider, to, iface, fn, args = []) {
  try {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await provider.call({ to, data });
    if (!raw || raw === "0x") return { status: "empty", value: null };
    const decoded = iface.decodeFunctionResult(fn, raw);
    const value = decoded[0];
    return { status: "success", value: typeof value === "bigint" ? value.toString() : value };
  } catch (err) {
    const msg = String(err?.message || err || "");
    return { status: "failure", error: msg.slice(0, 120) };
  }
}

async function scanVault(vault, provider) {
  const row = {
    chainId: vault.chainId,
    chain: vault.chain,
    address: vault.address,
    symbol: vault.symbol,
    apiTvlUsd: vault.apiTvlUsd,
    erc4626Asset: vault.erc4626Asset,
    vaultDecimals: vault.decimals,
    totalSupplyRaw: vault.totalSupplyRaw,
    totalAssetsRaw: vault.totalAssets,
    maxDepositDead: vault.maxDeposit,
    maxRedeemDead: vault.maxRedeem,
    localMatches: vault.localMatches || [],
  };

  const assetDecimalsCall = await fetchCall(provider, vault.erc4626Asset, ERC20, "decimals");
  const assetDecimals = assetDecimalsCall.status === "success" ? Number(assetDecimalsCall.value) : null;
  row.assetDecimals = assetDecimals;

  const oneShare = 10n ** BigInt(vault.decimals);
  const oneAsset = assetDecimals !== null ? 10n ** BigInt(assetDecimals) : null;

  const calls = await Promise.all([
    fetchCall(provider, vault.address, ERC4626, "convertToAssets", [oneShare]),
    fetchCall(provider, vault.address, ERC4626, "convertToShares", oneAsset ? [oneAsset] : [1n]),
    fetchCall(provider, vault.address, ERC4626, "previewDeposit", oneAsset ? [oneAsset] : [1n]),
    fetchCall(provider, vault.address, ERC4626, "previewRedeem", [oneShare]),
    fetchCall(provider, vault.address, ERC4626, "previewMint", [oneShare]),
    fetchCall(provider, vault.address, ERC4626, "previewWithdraw", oneAsset ? [oneAsset] : [1n]),
    fetchCall(provider, vault.address, ERC4626, "maxDeposit", [DEAD]),
    fetchCall(provider, vault.address, ERC4626, "maxRedeem", [DEAD]),
  ]);

  const [convertToAssetsUnit, convertToSharesUnit, previewDepositUnit, previewRedeemUnit, previewMintUnit, previewWithdrawUnit, maxDepositLive, maxRedeemLive] = calls;
  row.canonical = {
    oneShare: oneShare.toString(),
    oneAsset: oneAsset ? oneAsset.toString() : null,
    convertToAssetsUnit: convertToAssetsUnit.value,
    convertToSharesUnit: convertToSharesUnit.value,
    previewDepositUnit: previewDepositUnit.value,
    previewRedeemUnit: previewRedeemUnit.value,
    previewMintUnit: previewMintUnit.value,
    previewWithdrawUnit: previewWithdrawUnit.value,
    maxDepositLive: maxDepositLive.value,
    maxRedeemLive: maxRedeemLive.value,
  };

  const totalAssets = asBig(vault.totalAssets);
  const totalSupply = asBig(vault.totalSupplyRaw);

  // First-depositor / tiny-supply inflation risk
  const tinyThreshold = 10n ** BigInt(Math.max(0, vault.decimals - 6)); // 1e-6 of a full token
  row.firstDepositorRisk = totalSupply !== null && totalAssets !== null && (
    totalSupply === 0n
    || (totalSupply <= tinyThreshold && totalAssets > 0n)
  );
  row.zeroShareDeposit = previewDepositUnit.status === "success" && previewDepositUnit.value === "0";

  // Donation-sensitivity model: assets transferred directly to vault inflate share price.
  row.donationProbes = [];
  if (totalAssets !== null && totalSupply !== null && totalSupply > 0n && assetDecimals !== null) {
    const prePrice = Number(totalAssets) / Number(totalSupply); // assets per share (raw)
    const probeAmounts = [
      { label: "one-asset-unit", amount: 1n },
      { label: "thousand-asset-units", amount: 1000n },
      { label: "one-percent-tvl", amount: totalAssets / 100n },
    ];
    for (const probe of probeAmounts) {
      const postAssets = totalAssets + probe.amount;
      const postPrice = Number(postAssets) / Number(totalSupply);
      row.donationProbes.push({
        label: probe.label,
        donationRaw: probe.amount.toString(),
        prePriceAssetsPerShareRaw: prePrice,
        postPriceAssetsPerShareRaw: postPrice,
        priceDeltaBps: bps(postPrice - prePrice, prePrice),
      });
    }
  }
  row.maxDonationDeltaBps = row.donationProbes.length
    ? Math.max(...row.donationProbes.map((p) => p.priceDeltaBps || 0))
    : 0;

  // Downstream share-token acceptance from prefilter local matches
  row.consumerAccepted = row.localMatches.length > 0;
  row.consumerMatchFiles = row.localMatches.map((m) => m.file);

  // Watch candidate only if structural first-depositor/rounding anomaly or downstream acceptance exists
  row.watchCandidate = row.firstDepositorRisk || row.zeroShareDeposit || row.consumerAccepted;

  return row;
}

async function main() {
  const prefilter = loadJson(PREFILTER);
  if (!prefilter || !Array.isArray(prefilter.vaultRows)) {
    const failArtifact = {
      generatedAt: new Date().toISOString(),
      scanner: "tools/scan-concrete-erc4626-share-rate-donation.js",
      scope: "Concrete ERC4626 share-rate/donation sensitivity read-only sweep",
      safety: {
        rpcInventoryRead: false, rpcUrlsStored: false, envFilesRead: false, privateKeysRead: false,
        signedActions: false, exploitExecuteCalls: false, forkTransactions: false,
        routePositive: false, executableNow: false, signedActionJustified: false,
      },
      error: "prefilter-concrete-route-prefilter.json unavailable or malformed",
      summary: { routePositive: 0, watchCandidates: 0, vaultRows: 0 },
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(failArtifact, null, 2) + "\n");
    console.log("Concrete share-rate donation: PREFILTER MISSING");
    return;
  }

  const vaultRows = prefilter.vaultRows;
  const byChain = new Map();
  for (const v of vaultRows) {
    if (!byChain.has(v.chainId)) byChain.set(v.chainId, []);
    byChain.get(v.chainId).push(v);
  }

  const scannedRows = [];
  const rpcBlocked = [];

  for (const [chainId, vaults] of byChain) {
    const rpc = await resolveRpc(chainId);
    if (!rpc) {
      rpcBlocked.push({ chainId, skippedVaults: vaults.length });
      for (const v of vaults) {
        scannedRows.push({
          chainId: v.chainId, chain: v.chain, address: v.address, symbol: v.symbol,
          apiTvlUsd: v.apiTvlUsd, status: "rpc-blocked", watchCandidate: false,
        });
      }
      continue;
    }
    const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
    for (const v of vaults) {
      const row = await scanVault(v, provider);
      scannedRows.push(row);
    }
  }

  const watchCandidates = scannedRows.filter((r) => r.watchCandidate).length;
  const firstDepositorRiskRows = scannedRows.filter((r) => r.firstDepositorRisk).length;
  const zeroShareDepositRows = scannedRows.filter((r) => r.zeroShareDeposit).length;
  const consumerAcceptedRows = scannedRows.filter((r) => r.consumerAccepted).length;
  const maxDonationDeltaBps = scannedRows.length
    ? Math.max(0, ...scannedRows.map((r) => r.maxDonationDeltaBps || 0))
    : 0;

  const topWatch = scannedRows
    .filter((r) => r.watchCandidate)
    .sort((a, b) => (b.maxDonationDeltaBps || 0) - (a.maxDonationDeltaBps || 0) || (b.apiTvlUsd || 0) - (a.apiTvlUsd || 0))
    .slice(0, 8)
    .map((r) => ({
      chainId: r.chainId, address: r.address, symbol: r.symbol, apiTvlUsd: r.apiTvlUsd,
      firstDepositorRisk: r.firstDepositorRisk, zeroShareDeposit: r.zeroShareDeposit,
      consumerAccepted: r.consumerAccepted,
      maxDonationDeltaBps: r.maxDonationDeltaBps,
      consumerMatchFiles: r.consumerMatchFiles,
    }));

  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-concrete-erc4626-share-rate-donation.js",
    scope: "Concrete ERC4626 share-rate, first-depositor, donation-sensitivity, and downstream-acceptance sweep",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      executableNow: false,
      signedActionJustified: false,
      forkJustified: false,
    },
    inputs: {
      prefilter: path.relative(WORKSPACE, PREFILTER),
      prefilterGeneratedAt: prefilter.generatedAt,
      vaultRows: vaultRows.length,
    },
    summary: {
      vaultRows: scannedRows.length,
      rpcBlockedChains: rpcBlocked.length,
      watchCandidates,
      firstDepositorRiskRows,
      zeroShareDepositRows,
      consumerAcceptedRows,
      maxDonationDeltaBps,
      routePositive: 0,
      executableNow: 0,
      signedActionJustified: false,
    },
    rpcBlocked,
    topWatch,
    rows: scannedRows,
    blockers: [
      "Share-rate/donation probes are bounded static math on current totalAssets/totalSupply; they do not prove a permissionless extractive route",
      "First-depositor/rounding signals require an attacker-favorable deposit/redeem path and exit liquidity to become route-positive",
      "Downstream consumer matches are address-text hits only; they do not prove current collateral acceptance, caps, borrow cash, or liquidation economics",
      "No exact positive acquisition, borrow, liquidation, redemption, or unwind economics are proven",
      "No fork/static value-delta proof exists",
    ],
    nextRoutePositiveCriteria: [
      "A Concrete vault share is accepted as collateral by a live lending consumer with material borrow cash and overvalues it versus market/redeem value",
      "A donation or first-depositor manipulation produces a measurable share-price inflation that survives deposit/redeem fees and slippage",
      "Exact attacker-controlled asset movement is positive after gas, fees, and exit liquidity in a local fork/static proof",
    ],
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  const reportLines = [
    "# Concrete ERC4626 share-rate / donation-sensitivity triage",
    "",
    `**Classification:** WATCH / NO ROUTE-POSITIVE PROOF`,
    "",
    `Generated: ${artifact.generatedAt}`,
    `Scope: ${artifact.scope}`,
    "",
    "## Safety",
    "",
    "- RPC inventory used only for sanitized endpoint resolution; no RPC URLs stored.",
    "- No private keys, env files, signed actions, exploit execute calls, or fork transactions.",
    "- `routePositive=0`, `executableNow=0`, `signedActionJustified=false`.",
    "",
    "## Summary",
    "",
    `- Vaults scanned: ${artifact.summary.vaultRows}`,
    `- RPC-blocked chains: ${artifact.summary.rpcBlockedChains}`,
    `- Watch candidates: ${artifact.summary.watchCandidates}`,
    `- First-depositor/tiny-supply risk rows: ${artifact.summary.firstDepositorRiskRows}`,
    `- Zero-share deposit (1 unit -> 0 shares) rows: ${artifact.summary.zeroShareDepositRows}`,
    `- Downstream consumer-accepted rows: ${artifact.summary.consumerAcceptedRows}`,
    `- Max observed donation price delta (bps): ${artifact.summary.maxDonationDeltaBps}`,
    "",
    "## Top watch rows",
    "",
    topWatch.length
      ? ["| Chain | Vault | Symbol | TVL USD | FirstDepositor | ZeroShare | ConsumerAccepted | MaxDeltaBps |", "|---|---|---|---|---|---|---|---|", ...topWatch.map(r => `| ${r.chainId} | ${r.address} | ${r.symbol} | ${r.apiTvlUsd} | ${r.firstDepositorRisk} | ${r.zeroShareDeposit} | ${r.consumerAccepted} | ${r.maxDonationDeltaBps} |`)].join("\n")
      : "_No watch candidates._",
    "",
    "## Blockers",
    "",
    ...artifact.blockers.map((b) => `- ${b}`),
    "",
    "## Next route-positive criteria",
    "",
    ...artifact.nextRoutePositiveCriteria.map((c) => `- ${c}`),
    "",
  ];
  fs.writeFileSync(REPORT, reportLines.join("\n") + "\n");

  if (!QUIET) {
    console.log(`Concrete share-rate donation: vaults=${artifact.summary.vaultRows} watch=${artifact.summary.watchCandidates} firstDepositor=${artifact.summary.firstDepositorRiskRows} zeroShare=${artifact.summary.zeroShareDepositRows} consumerAccepted=${artifact.summary.consumerAcceptedRows} routePositive=0`);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
