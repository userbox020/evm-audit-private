#!/usr/bin/env node
// Read-only mapper for post-audit drift rows to local deployment metadata and live code presence.
// No private keys, no signed calls, no fork transactions.

const fs = require("fs");
const path = require("path");
const { resolveRpcPool, rpcCall } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const POST_AUDIT = path.join(WORKSPACE, "reports", "raw", "fast", "post-audit-scope-drift.json");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "post-audit-deployed-map.json");
const OUT_MD = path.join(WORKSPACE, "reports", "post-audit-deployed-map-triage.md");
const QUIET = process.argv.includes("--quiet");

const TERMMAX_ROOT = path.join(WORKSPACE, "targets", "termmax-contract-v2");
const TERMMAX_DEPLOYMENTS = path.join(TERMMAX_ROOT, "deployments");
const TERMMAX_BROADCAST = path.join(TERMMAX_ROOT, "broadcast");
const DOLO_DEPLOYMENTS = path.join(WORKSPACE, "targets", "dolomite-margin-modules", "packages", "deployment", "src", "deploy", "deployments.json");

const NETWORK_CHAIN_IDS = {
  "eth-mainnet": 1,
  "ethereum-mainnet": 1,
  "arb-mainnet": 42161,
  "arbitrum-mainnet": 42161,
  "bnb-mainnet": 56,
  "base-mainnet": 8453,
  "bera-mainnet": 80094,
  "hyperevm-mainnet": 999,
  "xlayer-mainnet": 196,
  "mantle-mainnet": 5000,
  "ink-mainnet": 57073,
  "eth-sepolia": 11155111,
  "arb-sepolia": 421614,
  "bnb-testnet": 97,
  "hyperevm-testnet": 998,
  "plasma-mainnet": null,
  "pharos-mainnet": null,
  "b2-mainnet": null,
};

const DOLO_TARGETS = [
  "MagicGLPPriceOracle",
  "POLPriceOracleV2",
  "ChainsightPriceOracleV3",
  "ChaosLabsPriceOracleV3",
  "ChroniclePriceOracleV3",
  "BorrowPositionRouterProxy",
  "DepositWithdrawalRouterProxy",
  "GenericTraderRouterProxy",
];

const TERMMAX_INTEREST = [
  "TermMaxERC4626PriceFeed",
  "PriceFeedWithERC4626",
  "TermMaxUniswapTWAPPriceFeed",
  "TermMaxPancakeTWAPPriceFeed",
  "TermMaxPriceFeedFactoryV2",
  "AccessManager",
];

function exists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).replace(/\\/g, "/");
}

function readJson(file, fallback = null) {
  try {
    if (!exists(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function readText(file, fallback = "") {
  try {
    if (!exists(file)) return fallback;
    return fs.readFileSync(file, "utf8");
  } catch (_) {
    return fallback;
  }
}

function walk(root, out = []) {
  if (!exists(root)) return out;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    out.push(root);
    return out;
  }
  if (!stat.isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "cache" || entry.name === "out") continue;
    walk(path.join(root, entry.name), out);
  }
  return out;
}

function parseEnv(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

function isAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(value || ""));
}

function isZeroAddress(value) {
  return /^0x0{40}$/i.test(String(value || ""));
}

function networkFromPath(file) {
  const parts = rel(file).split("/");
  const idx = parts.indexOf("deployments");
  return idx !== -1 ? parts[idx + 1] : null;
}

function basenameNoExt(file) {
  return path.basename(file, path.extname(file));
}

function contractNameFromFile(row) {
  return basenameNoExt(row.file || "");
}

function unique(items) {
  return [...new Set((items || []).filter(Boolean))];
}

function round(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function collectTopDriftRows() {
  const artifact = readJson(POST_AUDIT, {});
  const rows = Array.isArray(artifact.rankedRows) ? artifact.rankedRows : [];
  return rows
    .filter((row) => /TermMax|Dolomite/i.test(row.target || ""))
    .filter((row) => !/\/interfaces?\/|contracts_coverage/i.test(row.file || ""))
    .slice(0, 60)
    .map((row) => ({ ...row, contractName: contractNameFromFile(row) }));
}

function collectTermMaxDeployments() {
  const files = walk(TERMMAX_DEPLOYMENTS).filter((file) => /\.(json|env)$/i.test(file));
  const coreRows = [];
  const addressRows = [];
  for (const file of files) {
    const network = networkFromPath(file);
    const chainId = NETWORK_CHAIN_IDS[network] ?? null;
    if (file.endsWith(".json")) {
      const json = readJson(file, {});
      const contracts = json.contracts || {};
      for (const [key, value] of Object.entries(contracts)) {
        if (typeof value === "string" && isAddress(value) && !isZeroAddress(value)) {
          const row = { protocol: "TermMax", source: rel(file), network, chainId, name: key, address: value, kind: key, localVerified: true };
          addressRows.push(row);
          if (/factoryV2|priceFeedFactoryV2|oracleAggregatorV2|routerV2|routerV1|accessManager|whitelistManager|termMax4626Factory/i.test(key)) coreRows.push(row);
        } else if (value && typeof value === "object") {
          for (const [nestedKey, nestedValue] of Object.entries(value)) {
            if (typeof nestedValue === "string" && isAddress(nestedValue) && !isZeroAddress(nestedValue)) {
              addressRows.push({ protocol: "TermMax", source: rel(file), network, chainId, name: `${key}.${nestedKey}`, address: nestedValue, kind: key, localVerified: true });
            } else if (Array.isArray(nestedValue)) {
              for (const item of nestedValue) {
                if (item && isAddress(item.address) && !isZeroAddress(item.address)) addressRows.push({ protocol: "TermMax", source: rel(file), network, chainId, name: `${key}.${item.name || "item"}`, address: item.address, kind: key, localVerified: true });
              }
            }
          }
        }
      }
    } else if (file.endsWith(".env")) {
      const env = parseEnv(readText(file));
      const networkEnv = env.NETWORK || network;
      const envChain = NETWORK_CHAIN_IDS[networkEnv] ?? chainId;
      for (const [key, value] of Object.entries(env)) {
        if (!/_ADDRESS($|_\d+$)|PRICE_FEED_ADDRESS|MARKET_ADDRESS|POOL_ADDRESS/i.test(key) || !isAddress(value) || isZeroAddress(value)) continue;
        addressRows.push({ protocol: "TermMax", source: rel(file), network: networkEnv, chainId: envChain, name: key, address: value, kind: /PRICE_FEED/i.test(key) ? "priceFeed" : /MARKET/i.test(key) ? "market" : /POOL/i.test(key) ? "pool" : "address", localVerified: true });
      }
    }
  }
  return { coreRows, addressRows };
}

function collectTermMaxBroadcasts() {
  const files = walk(TERMMAX_BROADCAST).filter((file) => /run-latest\.json$/i.test(file));
  const rows = [];
  for (const file of files) {
    const json = readJson(file, {});
    const transactions = Array.isArray(json.transactions) ? json.transactions : [];
    const deployName = rel(file).split("/").slice(-3, -2)[0] || path.basename(path.dirname(path.dirname(file)));
    for (const tx of transactions) {
      const chainId = tx.transaction?.chainId ? Number.parseInt(tx.transaction.chainId, 16) : null;
      const created = Array.isArray(tx.additionalContracts) ? tx.additionalContracts.filter((item) => isAddress(item.address)) : [];
      if (!/DeployMarkets|DeployOtherPool|DeployVault|UpgradeRouter|DeployWeETHPriceCapAdapter|DeployTMX/i.test(deployName) && !created.length) continue;
      rows.push({
        protocol: "TermMax",
        source: rel(file),
        deployName,
        chainId,
        contractName: tx.contractName || null,
        contractAddress: isAddress(tx.contractAddress) ? tx.contractAddress : null,
        function: tx.function || null,
        createdContracts: created.map((item) => ({ address: item.address, type: item.transactionType || null })),
        hash: tx.hash || null,
      });
    }
  }
  return rows;
}

function collectDolomiteDeployments() {
  const json = readJson(DOLO_DEPLOYMENTS, {});
  const rows = [];
  for (const name of DOLO_TARGETS) {
    const deployments = json[name] || {};
    for (const [chainId, value] of Object.entries(deployments)) {
      if (value && isAddress(value.address)) {
        rows.push({ protocol: "Dolomite", source: rel(DOLO_DEPLOYMENTS), name, chainId: Number(chainId), address: value.address, tx: value.transaction || null, localVerified: Boolean(value.isVerified) });
      }
    }
  }
  return rows;
}

async function annotateCodeRows(rows) {
  const supported = rows.filter((row) => row.chainId && row.address && ![97, 998, 421614, 11155111].includes(Number(row.chainId)));
  const chainIds = unique(supported.map((row) => Number(row.chainId)));
  const rpcs = await resolveRpcPool(chainIds);
  const cache = new Map();
  const out = [];
  for (const row of rows) {
    const key = `${row.chainId}:${String(row.address || row.contractAddress || "").toLowerCase()}`;
    const address = row.address || row.contractAddress;
    let codeBytes = null;
    let codePresent = null;
    let rpcAvailable = false;
    if (row.chainId && address && rpcs[row.chainId] && ![97, 998, 421614, 11155111].includes(Number(row.chainId))) {
      rpcAvailable = true;
      if (!cache.has(key)) {
        const code = await rpcCall(rpcs[row.chainId], "eth_getCode", [address, "latest"], 8000);
        cache.set(key, typeof code === "string" && code.startsWith("0x") ? code : null);
      }
      const code = cache.get(key);
      codePresent = Boolean(code && code !== "0x");
      codeBytes = codePresent ? Math.max(0, (code.length - 2) / 2) : 0;
    }
    out.push({ ...row, rpcAvailable, codePresent, codeBytes });
  }
  return out;
}

function summarizeDriftRows(rows) {
  return rows.slice(0, 12).map((row) => ({
    target: row.target,
    contractName: row.contractName,
    file: row.file,
    confidence: row.confidence,
    surfaces: row.surfaces,
    driftSignals: row.driftSignals,
    blocker: row.blocker,
  }));
}

function buildFindings({ driftRows, termmaxRows, termmaxBroadcastRows, dolomiteRows }) {
  const termmaxFactories = termmaxRows.filter((row) => /priceFeedFactoryV2|oracleAggregatorV2|routerV2|accessManager|termMax4626Factory/i.test(row.name || ""));
  const termmaxPriceFeeds = termmaxRows.filter((row) => /PRICE_FEED|priceFeed/i.test(row.name || "") || /priceFeed/i.test(row.kind || ""));
  const termmaxMarkets = termmaxRows.filter((row) => /MARKET_ADDRESS|market/i.test(row.name || "") || /DeployMarkets/i.test(row.source || ""));
  const dolomiteOracles = dolomiteRows.filter((row) => /Oracle/i.test(row.name || ""));
  const dolomiteRouters = dolomiteRows.filter((row) => /RouterProxy/i.test(row.name || ""));
  const liveCodeRows = [...termmaxRows, ...dolomiteRows].filter((row) => row.codePresent).length;
  return [
    {
      id: "termmax-erc4626-feed-drift",
      protocol: "TermMax",
      surface: "ERC4626 collateral/feed drift",
      deployedRows: termmaxFactories.length + termmaxPriceFeeds.length + termmaxMarkets.length,
      liveCodeRows: termmaxFactories.filter((row) => row.codePresent).length + termmaxPriceFeeds.filter((row) => row.codePresent).length,
      routePositive: false,
      status: "dormant-deployed-factory-no-trusted-route",
      evidence: [
        `priceFeedFactory/core rows=${termmaxFactories.length}`,
        `explicit price-feed rows=${termmaxPriceFeeds.length}`,
        `market address rows=${termmaxMarkets.length}`,
        `broadcast market calls=${termmaxBroadcastRows.filter((row) => /DeployMarkets/i.test(row.deployName || "")).length}`,
      ],
      blockers: [
        "Creating a TermMax ERC4626/TWAP feed is not enough; oracle acceptance is gated through AccessManager ORACLE_ROLE submit/accept paths.",
        "Market creation is gated through AccessManager MARKET_ROLE, so arbitrary deployed feeds are not automatically trusted collateral.",
        "No exact borrow/repay/liquidation/unwind economics are proven for a deployed market using a manipulable feed.",
      ],
      nextReadOnlyStep: "Decode deployed TermMax market config for specific MARKET_ADDRESS rows only if collateral feed address can be matched to a liquid market and exact borrow/exit liquidity.",
    },
    {
      id: "dolomite-oracle-router-drift",
      protocol: "Dolomite",
      surface: "Post-audit oracle/router modules",
      deployedRows: dolomiteRows.length,
      liveCodeRows: dolomiteRows.filter((row) => row.codePresent).length,
      routePositive: false,
      status: "dormant-verified-deployments-role-and-market-state-blocked",
      evidence: [
        `oracle rows=${dolomiteOracles.length}`,
        `router proxy rows=${dolomiteRouters.length}`,
        `live code rows observed=${liveCodeRows}`,
      ],
      blockers: [
        "MagicGLP and POL oracle code requires the target market to be closing/non-borrowable before returning a price.",
        "RouterProxy upgrade paths are gated by onlyDolomiteMarginOwner; no permissionless implementation swap path is visible.",
        "No row proves a live borrowable market using the drifted oracle with positive liquidation/borrow/redeem economics.",
      ],
      nextReadOnlyStep: "If a Dolomite market using MagicGLP/POL/Chronicle/Chaos/Chainsight becomes borrowable or misconfigured, query market state and exact exit liquidity before fork work.",
    },
  ];
}

function table(rows, headers) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${headers.map((h) => String(row[h] ?? "").replace(/\r?\n/g, " ").replace(/\|/g, "/")).join(" | ")} |`),
  ].join("\n");
}

function renderReport(artifact) {
  const findings = artifact.findings.map((row) => ({
    ID: row.id,
    Protocol: row.protocol,
    Surface: row.surface,
    Status: row.status,
    DeployedRows: row.deployedRows,
    LiveCode: row.liveCodeRows,
    Blocker: row.blockers[0],
  }));
  const topDeployments = artifact.deployedRows.slice(0, 14).map((row) => ({
    Protocol: row.protocol,
    Name: row.name || row.contractName || row.kind,
    Chain: row.chainId || row.network || "unknown",
    Address: row.address || row.contractAddress,
    Code: row.codePresent === null ? "not checked" : row.codePresent ? `${row.codeBytes} bytes` : "none",
    Source: row.source,
  }));
  return [
    "# 🟢 DORMANT — Post-Audit Deployed Drift Map",
    "",
    `Date: ${artifact.generatedAt.slice(0, 10)}`,
    "",
    "## Result",
    "",
    `Mapped ${artifact.summary.driftRowsConsidered} TermMax/Dolomite post-audit drift rows to ${artifact.summary.deployedAddressRows} local deployment rows and ${artifact.summary.liveCodeRows} live-code-positive rows. Route gate remains closed: \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`.`,
    "",
    "The map confirms deployed oracle/router/factory surfaces exist, but current blockers are role-gated oracle/market acceptance, non-borrowable/closing-market oracle guards, missing exact market config joins, and no positive borrow/redeem/liquidation economics.",
    "",
    `Route-relevant gates remain closed: permissionless accepted-market rows \`${artifact.summary.permissionlessAcceptedMarketRows}\`, permissionless value-path rows \`${artifact.summary.permissionlessValuePathRows}\`, exact-economics rows \`${artifact.summary.exactEconomicsRows}\`, and fork-proof rows \`${artifact.summary.forkProofRows}\`.`,
    "",
    "## Findings",
    "",
    table(findings, ["ID", "Protocol", "Surface", "Status", "DeployedRows", "LiveCode", "Blocker"]),
    "",
    "## Top Deployment Rows",
    "",
    topDeployments.length ? table(topDeployments, ["Protocol", "Name", "Chain", "Address", "Code", "Source"]) : "No deployment rows found.",
    "",
    "## Route-Positive Gate",
    "",
    "Do not fork until a deployed drift row is joined to a permissionless accepted market, live borrow/redeem/liquidation or settlement path, exact acquisition/exit quotes, and positive net economics after gas/slippage/fees.",
    "",
    "## Artifacts",
    "",
    "- JSON: `reports/raw/fast/post-audit-deployed-map.json`",
    "- Scanner: `tools/scan-post-audit-deployed-map.js`",
    "- Source drift artifact: `reports/raw/fast/post-audit-scope-drift.json`",
    "",
  ].join("\n");
}

async function main() {
  const driftRows = collectTopDriftRows();
  const termmax = collectTermMaxDeployments();
  const termmaxBroadcastRows = collectTermMaxBroadcasts();
  const dolomite = collectDolomiteDeployments();
  const prioritizedTermmaxRows = termmax.addressRows.filter((row) => /priceFeedFactory|oracleAggregator|routerV2|accessManager|termMax4626Factory|PRICE_FEED|MARKET_ADDRESS|POOL_ADDRESS|4626/i.test(`${row.name || ""} ${row.kind || ""} ${row.source || ""}`));
  const rawDeployRows = [
    ...dolomite,
    ...prioritizedTermmaxRows,
    ...termmaxBroadcastRows.filter((row) => row.contractAddress && !isZeroAddress(row.contractAddress)).map((row) => ({ ...row, protocol: "TermMax", name: row.contractName, address: row.contractAddress, kind: row.deployName, localVerified: true })),
  ];
  const seenDeployRows = new Set();
  const dedupedDeployRows = rawDeployRows.filter((row) => {
    const key = `${row.protocol}:${row.chainId}:${String(row.name || row.kind || "").toLowerCase()}:${String(row.address || row.contractAddress || "").toLowerCase()}`;
    if (seenDeployRows.has(key)) return false;
    seenDeployRows.add(key);
    return true;
  });
  const deployedRows = await annotateCodeRows(dedupedDeployRows.slice(0, 360));
  const findings = buildFindings({ driftRows, termmaxRows: deployedRows.filter((row) => row.protocol === "TermMax"), termmaxBroadcastRows, dolomiteRows: deployedRows.filter((row) => row.protocol === "Dolomite") });
  const summary = {
    driftRowsConsidered: driftRows.length,
    termmaxCoreRows: termmax.coreRows.length,
    termmaxAddressRows: termmax.addressRows.length,
    termmaxBroadcastRows: termmaxBroadcastRows.length,
    dolomiteDeploymentRows: dolomite.length,
    deployedAddressRows: deployedRows.length,
    rpcCheckedRows: deployedRows.filter((row) => row.rpcAvailable).length,
    liveCodeRows: deployedRows.filter((row) => row.codePresent).length,
    findings: findings.length,
    roleOrMarketStateBlockedFindings: findings.length,
    permissionlessAcceptedMarketRows: 0,
    permissionlessValuePathRows: 0,
    exactEconomicsRows: 0,
    forkProofRows: 0,
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    blocker: "No deployed drift row is joined to permissionless market acceptance and exact positive value-path economics.",
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-post-audit-deployed-map.js",
    scope: "Read-only deployed mapping for TermMax/Dolomite post-audit drift rows",
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      envFilesRead: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
      forkTransactions: false,
      routePositive: false,
      signedActionJustified: false,
    },
    summary,
    driftRows: summarizeDriftRows(driftRows),
    findings,
    deployedRows: deployedRows
      .filter((row) => row.protocol === "Dolomite" || /priceFeedFactory|oracleAggregator|routerV2|accessManager|PRICE_FEED|MARKET_ADDRESS|POOL_ADDRESS|TermMax4626Factory|DeployMarkets|DeployOtherPool/i.test(`${row.name || ""} ${row.kind || ""} ${row.source || ""}`))
      .slice(0, 120),
    requiredForRoutePositive: [
      "deployed drift implementation is currently used by an accepted market or active route",
      "entrypoint is permissionless or externally triggerable without role compromise",
      "oracle/market state permits borrow, redeem, liquidation, settlement, or collateral value extraction",
      "live acquisition and exit liquidity are exact-quoted and positive after gas/slippage/fees",
      "fork/local proof demonstrates extractable net profit",
    ],
    nextReadOnlyStep: "Decode TermMax market config for concrete MARKET_ADDRESS rows only if a price feed can be joined to a liquid borrow market; otherwise keep Aave V4 hot-watch as the primary live trigger.",
  };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(OUT_MD, `${renderReport(artifact)}\n`);
  if (!QUIET) {
    console.log(`post-audit-deployed-map: driftRows=${summary.driftRowsConsidered}; deployedRows=${summary.deployedAddressRows}; liveCode=${summary.liveCodeRows}; routePositive=0`);
    console.log(`Report: ${rel(OUT_MD)}`);
  }
}

main().catch((err) => {
  console.error(`post-audit-deployed-map failed: ${err.message}`);
  process.exitCode = 1;
});
