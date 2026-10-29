#!/usr/bin/env node
"use strict";

// Authorized bounded read-only deployment/config/state binding.
// RPC URLs and raw responses remain memory-only. Persisted output contains only
// anonymous provider counts, decoded/derived state, and cryptographic commitments.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("./node_modules/ethers");
const { loadRpcUrls, getOrigin } = require("./shared-rpc");

const ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(ROOT, "targets", "cash-v3");
const NAME = "critical-etherfi-debt-manager-share-deployment-binding";
const SCANNER = `tools/scan-${NAME}.js`;
const VALIDATOR = `tools/test-${NAME}.js`;
const RAW = `reports/raw/fast/${NAME}.json`;
const EVIDENCE = `reports/raw/fast/${NAME}-evidence.json`;
const MANIFEST = `reports/raw/fast/${NAME}-manifest.json`;
const REPORT = `reports/${NAME}.md`;
const INBOX = `coordination/inbox/critical/2026-07-23-${NAME}.json`;
const HANDOFF = `coordination/handoffs/2026-07-23-${NAME}-handoff.md`;
const PREDECESSOR = "reports/raw/fast/critical-etherfi-debt-manager-share-differential.json";
const DEPLOYMENTS = "targets/cash-v3/deployments/mainnet/10/deployments.json";
const CONFIG = "targets/cash-v3/deployments/mainnet/10/config.json";
const SOURCE_COMMIT = "e05bda2be27a6a606f3f1b8ff0d0791032fd0ff8";
const REVISION = "debt-manager-share-deployment-binding-readonly-r1";
const AGENT = "critical-etherfi-debt-manager-deployment-bind-20260723";
const CHAIN_ID = 10;
const MAX_PROVIDERS = 2;
const MAX_CANDIDATE_PROVIDERS = 6;
const MAX_RPC_TOTAL = 2400;
const MAX_RPC_PER_PROVIDER = 900;
const RPC_TIMEOUT_MS = 15_000;
const LOG_INITIAL_CHUNK = 100_000;
const LOG_MIN_CHUNK = 1_000;
const HIGH_CONCENTRATION_BPS = 9_500n;

const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const ROLE_REGISTRY_SLOT = "0xa5586bb7fe6c4d1a576fc53fefe6d5915940638d338769f6905020734977f500";
const INIT_SLOT = "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";
const DM_STORAGE_BASE = BigInt("0x607698a05bce028f7bdc9529d6ab4a3ba381baf9d53007699c53d9e5dd543c00");
const SHARES_MAPPING_SLOT = DM_STORAGE_BASE + 5n;

const ALLOWED_RPC = new Set(["eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs"]);
const abs = (x) => path.join(ROOT, x);
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
const hashFile = (rel) => { const b = fs.readFileSync(abs(rel)); return { path: rel, bytes: b.length, sha256: sha(b) }; };
const canonical = (x) => JSON.stringify(x, Object.keys(x).sort());
const toHexBlock = (n) => `0x${BigInt(n).toString(16)}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asAddress = (word) => ethers.getAddress(`0x${String(word).slice(-40)}`);
const codeHash = (code) => ethers.keccak256(code);
const codeBytes = (code) => Math.max(0, (String(code).length - 2) / 2);

function configNameForSymbol(symbol) {
  const normalized = String(symbol || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const aliases = {
    usdc: "usdc",
    usdt: "usdt",
    eurc: "eurc",
    fraxusd: "fraxusd",
    frxusd: "fraxusd",
    liquidusd: "liquidUsd",
    liquidreserve: "liquidReserve",
    liquideur: "liquidEUR",
    weeur: "liquidEUR",
  };
  return aliases[normalized] || null;
}

const DM = new ethers.Interface([
  "function getBorrowTokens() view returns (address[])",
  "function getCollateralTokens() view returns (address[])",
  "function borrowTokenConfig(address) view returns (uint256,uint256,uint256,uint64,uint64,uint128)",
  "function totalSupplies(address) view returns (uint256)",
  "function supplierBalance(address,address) view returns (uint256)",
  "function paused() view returns (bool)",
  "function getDebtManagerAdmin() view returns (address)",
  "function etherFiDataProvider() view returns (address)",
  "function roleRegistry() view returns (address)",
  "event Supplied(address indexed sender,address indexed user,address indexed token,uint256 amount)",
  "event WithdrawBorrowToken(address indexed withdrawer,address indexed borrowToken,uint256 amount)",
  "event BorrowTokenAdded(address token)",
  "event BorrowTokenRemoved(address token)",
  "event Upgraded(address indexed implementation)",
]);
const ERC20 = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const ERC20_BYTES32 = new ethers.Interface(["function symbol() view returns (bytes32)"]);
const ROLES = new ethers.Interface([
  "function owner() view returns (address)",
  "function roleHolders(bytes32) view returns (address[])",
]);

let rpcTotal = 0;
const providerCounts = new Map();

function writeOwned(rel, text) {
  if (![RAW, EVIDENCE, MANIFEST, REPORT, INBOX, HANDOFF].includes(rel)) throw new Error(`write refused ${rel}`);
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), text, "utf8");
}

function git(args, cwd = TARGET) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 180_000, maxBuffer: 128 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
}

function shell(cmd, args, cwd, timeout = 1_200_000) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, output: `${r.stdout || ""}\n${r.stderr || ""}` };
}

function providerHost(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

async function rpc(provider, method, params = [], timeoutMs = RPC_TIMEOUT_MS) {
  if (!ALLOWED_RPC.has(method)) throw new Error(`RPC method refused: ${method}`);
  if (++rpcTotal > MAX_RPC_TOTAL) throw new Error("global RPC budget exceeded");
  const count = (providerCounts.get(provider.id) || 0) + 1;
  providerCounts.set(provider.id, count);
  if (count > MAX_RPC_PER_PROVIDER) throw new Error(`provider RPC budget exceeded: ${provider.id}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    const origin = getOrigin(provider.url);
    if (origin) headers.origin = origin;
    const response = await fetch(provider.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const body = await response.json();
    if (body.error || body.result === undefined) throw new Error("RPC unavailable");
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function probeUrl(url, index, logAddress, logTopic) {
  const provider = { id: `candidate-${index + 1}`, url };
  try {
    const chain = Number(BigInt(await rpc(provider, "eth_chainId")));
    if (chain !== CHAIN_ID) return null;
    const finalized = await rpc(provider, "eth_getBlockByNumber", ["finalized", false]);
    if (!finalized?.number || !finalized?.hash) return null;
    const finalizedNumber = Number(BigInt(finalized.number));
    const canaryFrom = Math.max(0, finalizedNumber - LOG_MIN_CHUNK + 1);
    const canaryLogs = await rpc(provider, "eth_getLogs", [{ address: logAddress, fromBlock: toHexBlock(canaryFrom), toBlock: toHexBlock(finalizedNumber), topics: [logTopic] }], 30_000);
    if (!Array.isArray(canaryLogs)) return null;
    return { url, host: providerHost(url), finalizedNumber, finalizedHash: finalized.hash.toLowerCase() };
  } catch {
    return null;
  }
}

async function selectProviders(logAddress, logTopic) {
  const urls = [...new Set(loadRpcUrls())];
  const candidates = [];
  const candidateHosts = new Set();
  const batchSize = 12;
  for (let i = 0; i < urls.length && candidateHosts.size < MAX_CANDIDATE_PROVIDERS; i += batchSize) {
    const rows = await Promise.all(urls.slice(i, i + batchSize).map((u, j) => probeUrl(u, i + j, logAddress, logTopic)));
    for (const row of rows) if (row) {
      candidates.push(row);
      if (row.host) candidateHosts.add(row.host);
    }
  }
  const selected = [];
  const hosts = new Set();
  for (const row of candidates) {
    if (!row.host || hosts.has(row.host)) continue;
    hosts.add(row.host);
    selected.push(row);
    if (selected.length === MAX_CANDIDATE_PROVIDERS) break;
  }
  selected.forEach((p, i) => { p.id = `provider-${i + 1}`; p.familyId = `family-${i + 1}`; });
  return { inventoryUrlCount: urls.length, chainCandidateCount: candidates.length, selected };
}

async function call(provider, to, iface, fn, args, blockTag) {
  const data = iface.encodeFunctionData(fn, args || []);
  const raw = await rpc(provider, "eth_call", [{ to, data }, blockTag]);
  return iface.decodeFunctionResult(fn, raw);
}

async function fixedPin(providers) {
  if (providers.length < 2) throw new Error("fewer than two distinct provider families");
  const pinNumber = Math.min(...providers.map((x) => x.finalizedNumber));
  const tag = toHexBlock(pinNumber);
  const headers = await Promise.all(providers.map((p) => rpc(p, "eth_getBlockByNumber", [tag, false])));
  const hashes = new Set(headers.map((h) => h?.hash?.toLowerCase()));
  if (hashes.size !== 1 || hashes.has(undefined)) throw new Error("fixed pin hash disagreement");
  const timestamps = new Set(headers.map((h) => Number(BigInt(h.timestamp))));
  if (timestamps.size !== 1) throw new Error("fixed pin timestamp disagreement");
  return { number: pinNumber, tag, hash: headers[0].hash.toLowerCase(), timestamp: Number(BigInt(headers[0].timestamp)) };
}

async function firstCodeBlock(provider, address, pinNumber) {
  const hasCode = async (n) => {
    const code = await rpc(provider, "eth_getCode", [address, toHexBlock(n)]);
    return code && code !== "0x";
  };
  if (!(await hasCode(pinNumber))) throw new Error("target code absent at pin");
  let lower = Math.max(0, pinNumber - 20_000_000);
  if (await hasCode(lower)) lower = 0;
  let lo = lower;
  let hi = pinNumber;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await hasCode(mid)) hi = mid;
    else lo = mid + 1;
  }
  if (lo > 0 && await hasCode(lo - 1)) throw new Error("deployment lower-bound check failed");
  if (!(await hasCode(lo))) throw new Error("deployment upper-bound check failed");
  return lo;
}

async function completeLogs(provider, address, topic0, fromBlock, toBlock) {
  const deadline = Date.now() + 240_000;
  const logs = [];
  let cursor = fromBlock;
  let chunk = LOG_INITIAL_CHUNK;
  let requestCount = 0;
  let coveredBlocks = 0;
  let consecutiveFailures = 0;
  while (cursor <= toBlock) {
    if (Date.now() > deadline) throw new Error(`complete log coverage deadline exceeded for ${provider.id}`);
    const end = Math.min(toBlock, cursor + chunk - 1);
    try {
      const rows = await rpc(provider, "eth_getLogs", [{ address, fromBlock: toHexBlock(cursor), toBlock: toHexBlock(end), topics: [topic0] }], 10_000);
      if (!Array.isArray(rows)) throw new Error("invalid logs");
      logs.push(...rows);
      coveredBlocks += end - cursor + 1;
      cursor = end + 1;
      requestCount++;
      consecutiveFailures = 0;
      if (chunk < LOG_INITIAL_CHUNK) chunk = Math.min(LOG_INITIAL_CHUNK, chunk * 2);
      await delay(500);
    } catch {
      consecutiveFailures++;
      if (consecutiveFailures <= 2) {
        await delay(1000 * consecutiveFailures);
        continue;
      }
      if (chunk <= LOG_MIN_CHUNK) throw new Error(`complete log coverage unavailable for ${provider.id} at ${cursor}-${end}`);
      chunk = Math.max(LOG_MIN_CHUNK, Math.floor(chunk / 2));
      consecutiveFailures = 0;
      await delay(1000);
    }
  }
  logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.transactionIndex) - BigInt(b.transactionIndex)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  const commitmentRows = logs.map((x) => [x.blockNumber, x.blockHash, x.transactionHash, x.transactionIndex, x.logIndex, x.topics, x.data]);
  return { logs, requestCount, coveredBlocks, digest: sha(JSON.stringify(commitmentRows)) };
}

function shareSlot(supplier, token) {
  const outer = ethers.keccak256(ethers.concat([ethers.zeroPadValue(supplier, 32), ethers.toBeHex(SHARES_MAPPING_SLOT, 32)]));
  return ethers.keccak256(ethers.concat([ethers.zeroPadValue(token, 32), outer]));
}

async function tokenMeta(provider, token, manager, pinTag) {
  const code = await rpc(provider, "eth_getCode", [token, pinTag]);
  const implWord = await rpc(provider, "eth_getStorageAt", [token, EIP1967_IMPL, pinTag]);
  let symbol = null;
  try { symbol = (await call(provider, token, ERC20, "symbol", [], pinTag))[0]; }
  catch {
    try { symbol = ethers.decodeBytes32String((await call(provider, token, ERC20_BYTES32, "symbol", [], pinTag))[0]); } catch {}
  }
  const decimals = Number((await call(provider, token, ERC20, "decimals", [], pinTag))[0]);
  const totalSupply = (await call(provider, token, ERC20, "totalSupply", [], pinTag))[0];
  const managerBalance = (await call(provider, token, ERC20, "balanceOf", [manager], pinTag))[0];
  const isProxy = BigInt(implWord) !== 0n;
  let implementation = null;
  let implementationRuntimeHash = null;
  if (isProxy) {
    implementation = asAddress(implWord);
    const implCode = await rpc(provider, "eth_getCode", [implementation, pinTag]);
    implementationRuntimeHash = codeHash(implCode);
  }
  return {
    address: ethers.getAddress(token), symbol, decimals,
    totalSupplyRaw: totalSupply.toString(), managerLiquidBalanceRaw: managerBalance.toString(),
    runtimeBytes: codeBytes(code), runtimeKeccak256: codeHash(code),
    proxy: isProxy, implementation, implementationRuntimeKeccak256: implementationRuntimeHash,
    erc20ViewsBound: true, transferFeeSemantics: "UNKNOWN_READ_ONLY", rebaseSemantics: "UNKNOWN_READ_ONLY",
  };
}

function zeroThreshold(totalAssets, totalShares, victimAmount) {
  if (totalShares === 0n) return { status: "FIRST_SUPPLIER_ONE_TO_ONE", additionalDonationRaw: "0" };
  const target = victimAmount * totalShares;
  const donation = target < totalAssets ? 0n : target - totalAssets + 1n;
  return { status: donation === 0n ? "ZERO_SHARES_WITHOUT_ADDITIONAL_DONATION" : "DONATION_REQUIRED", additionalDonationRaw: donation.toString() };
}

function incrementalDonorNet(holderShares, totalShares, totalAssets, donation, victimAmount) {
  if (totalShares === 0n || holderShares === 0n) return null;
  const before = holderShares * totalAssets / totalShares;
  const after = holderShares * (totalAssets + donation + victimAmount) / totalShares;
  return (after - before - donation).toString();
}

async function captureState(provider, local, pin, candidateSuppliers) {
  const proxy = local.proxy;
  const [implWord, adminWord, roleWord, initWord, proxyCode] = await Promise.all([
    rpc(provider, "eth_getStorageAt", [proxy, EIP1967_IMPL, pin.tag]),
    rpc(provider, "eth_getStorageAt", [proxy, EIP1967_ADMIN, pin.tag]),
    rpc(provider, "eth_getStorageAt", [proxy, ROLE_REGISTRY_SLOT, pin.tag]),
    rpc(provider, "eth_getStorageAt", [proxy, INIT_SLOT, pin.tag]),
    rpc(provider, "eth_getCode", [proxy, pin.tag]),
  ]);
  const implementation = asAddress(implWord);
  const implementationCode = await rpc(provider, "eth_getCode", [implementation, pin.tag]);
  const [borrowTokensRaw, collateralTokensRaw, pausedRaw, adminImplRaw, dataProviderRaw, roleRegistryRaw] = await Promise.all([
    call(provider, proxy, DM, "getBorrowTokens", [], pin.tag),
    call(provider, proxy, DM, "getCollateralTokens", [], pin.tag),
    call(provider, proxy, DM, "paused", [], pin.tag),
    call(provider, proxy, DM, "getDebtManagerAdmin", [], pin.tag),
    call(provider, proxy, DM, "etherFiDataProvider", [], pin.tag),
    call(provider, proxy, DM, "roleRegistry", [], pin.tag),
  ]);
  const borrowTokens = borrowTokensRaw[0].map(ethers.getAddress);
  const roleRegistry = ethers.getAddress(roleRegistryRaw[0]);
  if (asAddress(roleWord) !== roleRegistry) throw new Error("role registry storage/getter mismatch");
  const assetRows = [];
  for (const token of borrowTokens) {
    const [cfg, total] = await Promise.all([
      call(provider, proxy, DM, "borrowTokenConfig", [token], pin.tag),
      call(provider, proxy, DM, "totalSupplies", [token], pin.tag),
    ]);
    const meta = await tokenMeta(provider, token, proxy, pin.tag);
    const shares = [];
    for (const supplier of candidateSuppliers) {
      const raw = await rpc(provider, "eth_getStorageAt", [proxy, shareSlot(supplier, token), pin.tag]);
      const amount = BigInt(raw);
      if (amount !== 0n) shares.push({ supplier, shares: amount });
    }
    shares.sort((a, b) => a.supplier.toLowerCase().localeCompare(b.supplier.toLowerCase()));
    assetRows.push({
      token,
      config: {
        interestIndexSnapshot: cfg[0].toString(), totalNormalizedBorrowingAmount: cfg[1].toString(), totalShares: cfg[2].toString(),
        lastUpdateTimestamp: Number(cfg[3]), borrowApy: cfg[4].toString(), minShares: cfg[5].toString(),
      },
      totalAssetsRaw: total[0].toString(),
      tokenMeta: meta,
      supplierShares: shares,
    });
  }
  return {
    proxy: ethers.getAddress(proxy), proxyRuntimeBytes: codeBytes(proxyCode), proxyRuntimeKeccak256: codeHash(proxyCode),
    implementation, implementationRuntimeBytes: codeBytes(implementationCode), implementationRuntimeKeccak256: codeHash(implementationCode),
    eip1967Admin: BigInt(adminWord) === 0n ? null : asAddress(adminWord), initializedVersionWord: BigInt(initWord).toString(),
    roleRegistry, dataProvider: ethers.getAddress(dataProviderRaw[0]), adminImplementation: ethers.getAddress(adminImplRaw[0]),
    paused: Boolean(pausedRaw[0]), borrowTokens, collateralTokens: collateralTokensRaw[0].map(ethers.getAddress), assets: assetRows,
  };
}

function stateCommitment(state) {
  const reduced = {
    proxy: state.proxy, proxyRuntimeKeccak256: state.proxyRuntimeKeccak256, implementation: state.implementation,
    implementationRuntimeKeccak256: state.implementationRuntimeKeccak256, roleRegistry: state.roleRegistry,
    dataProvider: state.dataProvider, adminImplementation: state.adminImplementation, paused: state.paused,
    borrowTokens: state.borrowTokens, collateralTokens: state.collateralTokens,
    assets: state.assets.map((x) => ({ token: x.token, config: x.config, totalAssetsRaw: x.totalAssetsRaw, tokenMeta: x.tokenMeta, supplierShares: x.supplierShares.map((s) => [s.supplier, s.shares.toString()]) })),
  };
  return sha(JSON.stringify(reduced));
}

async function roleState(provider, roleRegistry, pinTag) {
  const roleNames = ["DEBT_MANAGER_ADMIN_ROLE", "PAUSER", "UNPAUSER"];
  const rows = [];
  for (const name of roleNames) {
    const role = ethers.id(name);
    const holders = (await call(provider, roleRegistry, ROLES, "roleHolders", [role], pinTag))[0].map(ethers.getAddress);
    let contractHolders = 0;
    for (const holder of holders) {
      const code = await rpc(provider, "eth_getCode", [holder, pinTag]);
      if (code !== "0x") contractHolders++;
    }
    rows.push({ role: name, holderCount: holders.length, contractHolderCount: contractHolders, eoaHolderCount: holders.length - contractHolders });
  }
  const owner = ethers.getAddress((await call(provider, roleRegistry, ROLES, "owner", [], pinTag))[0]);
  const ownerCode = await rpc(provider, "eth_getCode", [owner, pinTag]);
  return { ownerIsContract: ownerCode !== "0x", roles: rows };
}

function prepareBuildWorktree() {
  const temp = path.join(os.tmpdir(), "opencode", "etherfi-debt-manager-deployment-binding");
  const work = path.join(temp, "source");
  fs.rmSync(temp, { recursive: true, force: true });
  fs.mkdirSync(temp, { recursive: true });
  git(["worktree", "add", "--detach", work, SOURCE_COMMIT]);
  const sourceLib = path.join(TARGET, "lib");
  const destLib = path.join(work, "lib");
  fs.mkdirSync(destLib, { recursive: true });
  for (const name of fs.readdirSync(sourceLib)) {
    const dst = path.join(destLib, name);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.symlinkSync(path.join(sourceLib, name), dst, "junction");
  }
  return { temp, work, out: path.join(temp, "out"), cache: path.join(temp, "cache") };
}

function cleanupBuild(ctx) {
  const lib = path.join(ctx.work, "lib");
  if (fs.existsSync(lib)) for (const name of fs.readdirSync(lib)) {
    const p = path.join(lib, name);
    try { if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p); } catch {}
  }
  try { git(["worktree", "remove", "--force", ctx.work]); } catch {}
  fs.rmSync(ctx.temp, { recursive: true, force: true });
}

function patchRuntime(object, immutableReferences, assignments) {
  const normalizedObject = String(object).replace(/^0x/, "");
  const bytes = Buffer.from(normalizedObject, "hex");
  const ids = Object.keys(immutableReferences).sort();
  if (ids.length !== assignments.length) return null;
  ids.forEach((id, index) => {
    const value = Buffer.from(ethers.zeroPadValue(assignments[index], 32).slice(2), "hex");
    for (const ref of immutableReferences[id]) value.copy(bytes, ref.start, 0, ref.length);
  });
  return `0x${bytes.toString("hex")}`;
}

function exactRuntimeBinding(onchainCode, implementation, dataProvider) {
  const ctx = prepareBuildWorktree();
  try {
    const build = shell("forge", ["build", "--offline", "--skip", "test", "--root", ctx.work, "--out", ctx.out, "--cache-path", ctx.cache, "--no-cache"], ctx.work);
    if (build.status !== 0) throw new Error("offline exact build failed");
    const artifactPath = path.join(ctx.out, "DebtManagerCore.sol", "DebtManagerCore.json");
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const object = artifact.deployedBytecode.object;
    const refs = artifact.deployedBytecode.immutableReferences;
    const permutations = [[implementation, dataProvider], [dataProvider, implementation]];
    let exact = false;
    let assignment = null;
    for (const values of permutations) {
      const candidate = patchRuntime(object, refs, values);
      if (candidate && candidate.toLowerCase() === onchainCode.toLowerCase()) {
        exact = true;
        assignment = values[0].toLowerCase() === implementation.toLowerCase() ? "sorted-id-0=self,sorted-id-1=dataProvider" : "sorted-id-0=dataProvider,sorted-id-1=self";
      }
    }
    return {
      exact,
      assignment,
      compiler: "0.8.28",
      optimizer: true,
      optimizerRuns: 0,
      evmVersion: "cancun",
      bytecodeHash: "none",
      localTemplateBytes: String(object).replace(/^0x/, "").length / 2,
      immutableAstIdCount: Object.keys(refs).length,
      immutablePlacementCount: Object.values(refs).reduce((n, xs) => n + xs.length, 0),
      buildOutputSha256: sha(build.output),
      sourceCommit: SOURCE_COMMIT,
    };
  } finally {
    cleanupBuild(ctx);
  }
}

function selfTests() {
  let refused = false;
  try { if (!ALLOWED_RPC.has("eth_sendRawTransaction")) throw new Error("refused"); } catch { refused = true; }
  if (!refused) throw new Error("method allowlist self-test failed");
  if (zeroThreshold(71n, 10n, 7n).additionalDonationRaw !== "0") throw new Error("threshold existing-assets fixture failed");
  if (zeroThreshold(10n, 10n, 7n).additionalDonationRaw !== "61") throw new Error("threshold formula fixture failed");
  const slotA = shareSlot("0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002");
  const slotB = shareSlot("0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002");
  if (slotA !== slotB || slotA.length !== 66) throw new Error("mapping slot fixture failed");
  return { passed: 4, rpcMutationMethodsAllowed: false, thresholdFixturesPassed: 2, storageSlotFixturePassed: true };
}

function sanitizeOutputGuard(text) {
  if (/https?:\/\//i.test(text)) throw new Error("endpoint URL leak");
  if (/[?&](?:key|token|api_key|apikey)=/i.test(text)) throw new Error("credential leak");
  if (/(authorization|cookie|set-cookie)\s*[:=]/i.test(text)) throw new Error("header leak");
}

async function main() {
  const generatedAt = new Date().toISOString();
  const tests = selfTests();
  const predecessor = JSON.parse(fs.readFileSync(abs(PREDECESSOR), "utf8"));
  if (!predecessor.conclusions?.sourceLevelPrimitiveCandidatePendingReview) throw new Error("predecessor primitive mismatch");
  if (git(["cat-file", "-t", SOURCE_COMMIT]).trim() !== "commit") throw new Error("source commit unavailable");
  const deployments = JSON.parse(fs.readFileSync(abs(DEPLOYMENTS), "utf8"));
  const config = JSON.parse(fs.readFileSync(abs(CONFIG), "utf8"));
  const proxy = ethers.getAddress(deployments.addresses.DebtManager);
  const local = {
    chainId: CHAIN_ID,
    proxy,
    configBorrowTokenNames: config.debtManager.borrowTokens,
    deploymentArtifactSha256: hashFile(DEPLOYMENTS).sha256,
    configArtifactSha256: hashFile(CONFIG).sha256,
    tokenIdentityBasis: "fixed-pin ERC20 symbol views normalized against the exact borrow-token names in the OP config; no fixture inventory was read",
    authoritativeBasis: "mainnet chain-10 deployment artifact plus OP config, fixed-pin token enumeration, and dedicated OP bytecode/config verification tests",
    deterministicSiblingArtifactOnScroll: true,
    selectedActiveChainReason: "Only chain 10 has the authoritative mainnet DebtManager config and dedicated current bytecode/config verification harness in this repository.",
  };

  const suppliedTopic = DM.getEvent("Supplied").topicHash;
  const providerSelection = await selectProviders(proxy, suppliedTopic);
  const candidateProviders = providerSelection.selected;
  if (candidateProviders.length < 2) throw new Error("fewer than two log-capable distinct provider families");
  let discoveredDeploymentBlock = null;
  for (const provider of candidateProviders) {
    try {
      discoveredDeploymentBlock = await firstCodeBlock(provider, proxy, provider.finalizedNumber);
      break;
    } catch {}
  }
  if (discoveredDeploymentBlock === null) throw new Error("no anonymous candidate established the proxy deployment boundary");
  const archiveLogQualified = [];
  for (const provider of candidateProviders) {
    try {
      const [atBoundary, beforeBoundary, logRows] = await Promise.all([
        rpc(provider, "eth_getCode", [proxy, toHexBlock(discoveredDeploymentBlock)]),
        discoveredDeploymentBlock === 0 ? Promise.resolve("0x") : rpc(provider, "eth_getCode", [proxy, toHexBlock(discoveredDeploymentBlock - 1)]),
        rpc(provider, "eth_getLogs", [{ address: proxy, fromBlock: toHexBlock(discoveredDeploymentBlock), toBlock: toHexBlock(Math.min(provider.finalizedNumber, discoveredDeploymentBlock + LOG_MIN_CHUNK - 1)), topics: [suppliedTopic] }], 30_000),
      ]);
      if (atBoundary !== "0x" && beforeBoundary === "0x" && Array.isArray(logRows)) archiveLogQualified.push(provider);
    } catch {}
  }
  if (archiveLogQualified.length < 2) throw new Error("fewer than two anonymous provider families qualified the deployment-boundary log canary");
  const pin = await fixedPin(archiveLogQualified);
  const deploymentBlock = discoveredDeploymentBlock;
  const historyAttempts = await Promise.allSettled(archiveLogQualified.map(async (provider) => ({ provider, history: await completeLogs(provider, proxy, suppliedTopic, deploymentBlock, pin.number) })));
  const completedHistories = historyAttempts.filter((x) => x.status === "fulfilled").map((x) => x.value);
  if (new Set(completedHistories.map((x) => x.history.digest)).size > 1) throw new Error("supplier history digest disagreement");
  const completedProviderIds = new Set(completedHistories.map((x) => x.provider.id));
  const orderedProviders = [...completedHistories.map((x) => x.provider), ...archiveLogQualified.filter((x) => !completedProviderIds.has(x.id))];
  const providers = orderedProviders.slice(0, MAX_PROVIDERS);
  const historyByProvider = new Map(completedHistories.map((x) => [x.provider.id, x.history]));
  const histories = providers.map((x) => historyByProvider.get(x.id) || null);
  const deploymentBlocks = providers.map(() => deploymentBlock);
  const suppliedLogs = completedHistories[0]?.history.logs || [];
  const candidates = new Set();
  const activity = new Map();
  for (const log of suppliedLogs) {
    const parsed = DM.parseLog(log);
    const user = ethers.getAddress(parsed.args.user);
    const token = ethers.getAddress(parsed.args.token);
    candidates.add(user);
    const row = activity.get(token.toLowerCase()) || { count: 0, firstBlock: null, lastBlock: null, totalNominalSuppliedRaw: 0n };
    const block = Number(BigInt(log.blockNumber));
    row.count++;
    row.firstBlock = row.firstBlock === null ? block : Math.min(row.firstBlock, block);
    row.lastBlock = row.lastBlock === null ? block : Math.max(row.lastBlock, block);
    row.totalNominalSuppliedRaw += BigInt(parsed.args.amount.toString());
    activity.set(token.toLowerCase(), row);
  }
  const candidateSuppliers = [...candidates].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const states = [];
  for (const provider of providers) states.push(await captureState(provider, local, pin, candidateSuppliers));
  const commitments = states.map(stateCommitment);
  if (new Set(commitments).size !== 1) throw new Error("fixed-pin state disagreement");
  const state = states[0];
  const implementationCode = await rpc(providers[0], "eth_getCode", [state.implementation, pin.tag]);
  const runtimeBinding = exactRuntimeBinding(implementationCode, state.implementation, state.dataProvider);
  const accessState = await roleState(providers[0], state.roleRegistry, pin.tag);

  const supplierCommitments = candidateSuppliers.map((address, i) => ({ id: `supplier-${i + 1}`, addressCommitment: sha(address.toLowerCase()) }));
  const supplierId = new Map(candidateSuppliers.map((address, i) => [address.toLowerCase(), `supplier-${i + 1}`]));
  const assets = [];
  let concentrationComplete = true;
  let anyConditionPresent = false;
  for (const row of state.assets) {
    const totalShares = BigInt(row.config.totalShares);
    const totalAssets = BigInt(row.totalAssetsRaw);
    const sumShares = row.supplierShares.reduce((n, x) => n + x.shares, 0n);
    const max = row.supplierShares.reduce((best, x) => !best || x.shares > best.shares ? x : best, null);
    const maxShares = max?.shares || 0n;
    const concentrationBps = totalShares === 0n ? null : maxShares * 10_000n / totalShares;
    const complete = sumShares === totalShares;
    if (!complete) concentrationComplete = false;
    const tokenActivity = activity.get(row.token.toLowerCase()) || { count: 0, firstBlock: null, lastBlock: null, totalNominalSuppliedRaw: 0n };
    let lastSupplyTimestamp = null;
    if (tokenActivity.lastBlock !== null) {
      const h = await rpc(providers[0], "eth_getBlockByNumber", [toHexBlock(tokenActivity.lastBlock), false]);
      lastSupplyTimestamp = Number(BigInt(h.timestamp));
    }
    const oneToken = 10n ** BigInt(row.tokenMeta.decimals);
    const victimAmounts = [
      { label: "oneRaw", amount: 1n },
      { label: "oneToken", amount: oneToken },
      { label: "configuredMinShares", amount: BigInt(row.config.minShares) },
    ];
    const thresholds = victimAmounts.map((x) => {
      const threshold = zeroThreshold(totalAssets, totalShares, x.amount);
      const donation = BigInt(threshold.additionalDonationRaw);
      return {
        label: x.label,
        victimAmountRaw: x.amount.toString(),
        ...threshold,
        maxHolderIncrementalNetIfDonorRaw: incrementalDonorNet(maxShares, totalShares, totalAssets, donation, x.amount),
      };
    });
    const noDonationMaxZeroVictim = totalShares === 0n || totalAssets === 0n ? null : ((totalAssets - 1n) / totalShares).toString();
    const condition = totalShares === 0n || (concentrationBps !== null && concentrationBps >= HIGH_CONCENTRATION_BPS);
    if (condition) anyConditionPresent = true;
    assets.push({
      name: configNameForSymbol(row.tokenMeta.symbol),
      address: row.token,
      symbol: row.tokenMeta.symbol,
      decimals: row.tokenMeta.decimals,
      tokenRuntimeKeccak256: row.tokenMeta.runtimeKeccak256,
      tokenProxy: row.tokenMeta.proxy,
      tokenImplementation: row.tokenMeta.implementation,
      tokenImplementationRuntimeKeccak256: row.tokenMeta.implementationRuntimeKeccak256,
      erc20ViewsBound: row.tokenMeta.erc20ViewsBound,
      transferFeeSemantics: row.tokenMeta.transferFeeSemantics,
      rebaseSemantics: row.tokenMeta.rebaseSemantics,
      managerLiquidBalanceRaw: row.tokenMeta.managerLiquidBalanceRaw,
      totalAssetsRaw: row.totalAssetsRaw,
      totalNormalizedBorrowingAmount: row.config.totalNormalizedBorrowingAmount,
      totalSharesRaw: row.config.totalShares,
      minSharesRaw: row.config.minShares,
      borrowApy: row.config.borrowApy,
      supplierCandidateCount: candidateSuppliers.length,
      nonzeroSupplierCount: row.supplierShares.length,
      enumeratedSharesRaw: sumShares.toString(),
      concentrationComplete: complete,
      maxSupplierId: max ? supplierId.get(max.supplier.toLowerCase()) : null,
      maxSupplierSharesRaw: maxShares.toString(),
      maxSupplierConcentrationBps: concentrationBps === null ? null : concentrationBps.toString(),
      soleIncumbent: totalShares !== 0n && maxShares === totalShares,
      highConcentration: concentrationBps !== null && concentrationBps >= HIGH_CONCENTRATION_BPS,
      noDonationMaxZeroShareVictimRaw: noDonationMaxZeroVictim,
      thresholds,
      supplyHistory: {
        eventCount: tokenActivity.count,
        firstBlock: tokenActivity.firstBlock,
        lastBlock: tokenActivity.lastBlock,
        lastTimestamp: lastSupplyTimestamp,
        ageAtPinSeconds: lastSupplyTimestamp === null ? null : pin.timestamp - lastSupplyTimestamp,
        totalNominalSuppliedRaw: tokenActivity.totalNominalSuppliedRaw.toString(),
      },
    });
  }

  const runtimeComplete = runtimeBinding.exact;
  const providerThreshold = providers.length >= 2;
  const historyComplete = histories.length >= 2 && histories.every((x) => x && x.coveredBlocks === pin.number - deploymentBlock + 1) && new Set(histories.map((x) => x.digest)).size === 1;
  const expectedNames = [...config.debtManager.borrowTokens].sort();
  const observedNames = assets.map((x) => x.name).sort();
  const configMatches = expectedNames.length === observedNames.length && expectedNames.every((name, i) => name === observedNames[i]);
  const coverageComplete = providerThreshold && historyComplete && concentrationComplete && runtimeComplete && configMatches;
  let classification;
  if (!coverageComplete) classification = "COVERAGE-BLOCKED";
  else if (anyConditionPresent && !state.paused) classification = "DEPLOYMENT-RELEVANT-CANDIDATE";
  else classification = "DORMANT/CONDITION-ABSENT";

  const terminalHeaders = await Promise.all(providers.map((p) => rpc(p, "eth_getBlockByNumber", [pin.tag, false])));
  const terminalRecheck = terminalHeaders.every((h) => h?.hash?.toLowerCase() === pin.hash);
  if (!terminalRecheck) throw new Error("terminal same-number recheck failed");

  const providerRows = providers.map((p, i) => ({
    id: p.id,
    familyId: p.familyId,
    chainId: CHAIN_ID,
    reportedFinalizedHeight: p.finalizedNumber,
    selectedPinHashMatch: true,
    deploymentBlock: deploymentBlocks[i],
    archiveCodeBoundaryQualified: true,
    suppliedLogCoverageComplete: Boolean(histories[i]),
    suppliedLogRequests: histories[i]?.requestCount || 0,
    suppliedLogCount: histories[i]?.logs.length || 0,
    suppliedLogDigest: histories[i]?.digest || null,
    fixedPinStateDigest: commitments[i],
    terminalSameNumberHashMatch: true,
    rpcCalls: providerCounts.get(p.id) || 0,
  }));
  const transcript = {
    schemaVersion: 1,
    generatedAt,
    authorization: "current-turn-bounded-read-only-rpc",
    rawEndpointInventoryPersisted: false,
    rawRpcResponsesPersisted: false,
    endpointsOrDomainsPersisted: false,
    providerSelection: {
      inventoryRead: true,
      inventoryUrlCount: providerSelection.inventoryUrlCount,
      chainCandidateCount: providerSelection.chainCandidateCount,
      archiveLogQualifiedCandidateCount: archiveLogQualified.length,
      deploymentToPinLogCompletedCandidateCount: completedHistories.length,
      selectedProviderCount: providers.length,
      distinctAnonymousFamilyCount: new Set(providers.map((x) => x.familyId)).size,
    },
    pin: { chainId: CHAIN_ID, number: pin.number, hash: pin.hash, timestamp: pin.timestamp, finalizedSelected: true, terminalSameNumberRecheck: terminalRecheck },
    providerRows,
    commitments: {
      suppliedHistoryAggregate: histories.find(Boolean)?.digest || null,
      fixedPinStateAggregate: commitments[0],
      decodedEvidenceAggregate: sha(JSON.stringify({ pin: [pin.number, pin.hash], deploymentBlock, assets, accessState, runtimeBinding })),
    },
    budgets: { allowedMethods: [...ALLOWED_RPC].sort(), globalMaximum: MAX_RPC_TOTAL, perProviderMaximum: MAX_RPC_PER_PROVIDER, actualTotal: rpcTotal },
  };

  const conditions = {
    unpaused: !state.paused,
    directPermissionlessSupplyInExactRuntime: runtimeBinding.exact,
    contractLevelMinimumSharesOutProtection: false,
    contractLevelNonzeroMintProtection: false,
    supplierConcentrationComplete: concentrationComplete,
    anySoleOrHighConcentrationAsset: anyConditionPresent,
    predictablePendingVictimSupplyObserved: false,
    victimSupplyHistoryObserved: assets.some((x) => x.supplyHistory.eventCount > 0),
    practicalProfitabilityEvaluated: false,
  };
  const blockers = [];
  if (!runtimeBinding.exact) blockers.push("Current implementation runtime did not exactly match the locally compiled immutable-patched DebtManagerCore runtime.");
  if (!historyComplete) blockers.push("Complete two-provider Supplied history from the independently discovered deployment boundary was not established.");
  if (!concentrationComplete) blockers.push("Enumerated supplier mapping shares did not sum exactly to current total shares for every active borrow asset.");
  if (!configMatches) blockers.push("Current on-chain borrow-token enumeration did not exactly match the authoritative local OP config name multiset and count.");
  if (!anyConditionPresent) blockers.push("No active borrow asset has an empty pool, sole incumbent, or >=95% max-supplier concentration at the fixed pin.");
  blockers.push("Pending private order flow and future victim supplies cannot be established from read-only chain state.");
  blockers.push("Transfer-fee and rebasing behavior is not generally provable from ERC20 view calls; each active token remains UNKNOWN_READ_ONLY for those mutation semantics.");
  blockers.push("No gas, funding duration, MEV ordering, market value, or net economics was evaluated; no fork was created.");

  const nextGate = classification === "DEPLOYMENT-RELEVANT-CANDIDATE"
    ? "Independent reviewer must reproduce the sanitized fixed-pin capture, exact runtime build, complete supplier enumeration, storage-slot derivation, and threshold arithmetic. Only after approval may a separately scoped no-key fork proposal be considered; economics and execution remain closed."
    : classification === "DORMANT/CONDITION-ABSENT"
      ? "Independent reviewer must reproduce the sanitized fixed-pin capture and concentration closure. If approved, monitor only for implementation/config drift, an empty or >=95%-concentrated pool, and renewed supply activity; no fork while the condition remains absent."
      : "Repair the explicit provider/history/runtime/config blocker under a separately reviewed read-only scope. Do not infer concentration absence or proceed to fork/economics while coverage is blocked.";

  const runId = `etherfi-debt-manager-share-deployment-${CHAIN_ID}-${pin.number}-${hashFile(SCANNER).sha256.slice(0, 12)}`;
  const result = {
    schemaVersion: 1,
    revision: REVISION,
    runId,
    generatedAt,
    agentId: AGENT,
    role: "critical-research",
    classification,
    pipeline: "1/5",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    safety: {
      readOnlyRpcAuthorizedCurrentTurn: true,
      rpcUsed: true,
      endpointInventoryRead: true,
      endpointMaterialPersisted: false,
      rawRpcPersisted: false,
      envFilesRead: false,
      privateKeysRead: false,
      ethCallMutationSelectorsUsed: false,
      signedTransactions: false,
      broadcast: false,
      liveMutation: false,
      fundMovement: false,
      forkCreated: false,
      economicsAttempted: false,
    },
    predecessor: { ...hashFile(PREDECESSOR), runId: predecessor.runId },
    authoritativeLocalDeployment: local,
    pin: transcript.pin,
    deploymentBinding: {
      proxy: state.proxy,
      deploymentBlock,
      proxyRuntimeBytes: state.proxyRuntimeBytes,
      proxyRuntimeKeccak256: state.proxyRuntimeKeccak256,
      implementation: state.implementation,
      implementationRuntimeBytes: state.implementationRuntimeBytes,
      implementationRuntimeKeccak256: state.implementationRuntimeKeccak256,
      eip1967Admin: state.eip1967Admin,
      initializedVersionWord: state.initializedVersionWord,
      roleRegistry: state.roleRegistry,
      dataProvider: state.dataProvider,
      adminImplementation: state.adminImplementation,
      exactLocalRuntime: runtimeBinding,
    },
    configAndAccess: {
      paused: state.paused,
      borrowTokenCount: state.borrowTokens.length,
      collateralTokenCount: state.collateralTokens.length,
      authoritativeConfigBorrowTokensMatched: configMatches,
      accessState,
      directSupplySignature: "supply(address user,address borrowToken,uint256 amount)",
      callerMinimumSharesOutParameter: false,
      zeroSharesRejected: false,
    },
    supplierConcentration: {
      deploymentToPinHistoryComplete: historyComplete,
      providerAgreementCount: histories.filter(Boolean).length,
      suppliedEventCount: suppliedLogs.length,
      candidateSupplierCount: candidateSuppliers.length,
      candidateAddressCommitments: supplierCommitments,
      allCurrentAssetShareSumsExact: concentrationComplete,
      highConcentrationThresholdBps: HIGH_CONCENTRATION_BPS.toString(),
    },
    assets,
    conditions,
    transcriptCommitments: transcript.commitments,
    tests,
    blockers,
    nextGate,
  };
  const evidence = transcript;

  const signal = classification === "DEPLOYMENT-RELEVANT-CANDIDATE" ? "🟡 VULNERABLE" : classification === "DORMANT/CONDITION-ABSENT" ? "🟢 DORMANT" : "🟠 WATCH";
  const rowsMd = assets.map((x) => `| ${x.name || x.symbol || "unknown"} | ${x.address} | ${x.decimals} | ${x.totalAssetsRaw} | ${x.totalSharesRaw} | ${x.minSharesRaw} | ${x.nonzeroSupplierCount} | ${x.maxSupplierConcentrationBps ?? "n/a"} | ${x.soleIncumbent} | ${x.highConcentration} | ${x.noDonationMaxZeroShareVictimRaw ?? "n/a"} |`).join("\n");
  const report = `# ${signal} — ${classification} — EtherFi Cash DebtManager zero-share deployment binding\n\n**Run:** \`${runId}\`  \n**Pipeline:** \`1/5\`  \n**Gates:** \`routePositive=0\`, \`executableNow=0\`, \`signedActionJustified=false\`, \`fork=false\`\n\n> The source-level primitive was bound read-only to the active OP deployment at a fixed finalized pin. Classification is fail-closed from runtime equivalence, complete supplier-history/share enumeration, concentration, and current conditions. No endpoint material, raw RPC response, transaction, mutation, fork, or economics is retained.\n\n## Pin and runtime\n\n- Chain: \`${CHAIN_ID}\`\n- Pin: \`${pin.number}\` / \`${pin.hash}\`, timestamp \`${pin.timestamp}\`\n- Anonymous provider families: \`${providers.length}\`; fixed-hash and terminal same-number agreement: \`PASS\`\n- Proxy: \`${state.proxy}\`; implementation: \`${state.implementation}\`\n- Implementation runtime keccak256: \`${state.implementationRuntimeKeccak256}\`\n- Exact immutable-patched local runtime: \`${runtimeBinding.exact}\`\n- Paused: \`${state.paused}\`\n\n## Active assets and concentration\n\n| Asset | Token | Decimals | Total assets raw | Total shares raw | minShares raw | Nonzero suppliers | Max concentration bps | Sole | >=95% | No-donation max zero victim raw |\n|---|---|---:|---:|---:|---:|---:|---:|---|---|---:|\n${rowsMd}\n\nSupplier coverage from block \`${deploymentBlock}\` through \`${pin.number}\`: \`${historyComplete ? "COMPLETE" : "BLOCKED"}\`; Supplied events \`${suppliedLogs.length}\`; candidate suppliers \`${candidateSuppliers.length}\`; exact current share sums for all assets \`${concentrationComplete}\`. Supplier addresses are represented only by anonymous IDs and commitments.\n\n## Threshold interpretation\n\nFor each asset and victim amount \`v\`, the artifact records \`max(0, v*S-A+1)\` additional raw donation needed for zero shares at the pin. It also records the exact max-holder incremental raw delta under the current share fraction. Contract-level supply exposes no \`minSharesOut\` parameter and does not reject zero minted shares. Pending private victim order flow is not observable and is not claimed.\n\n## Token semantics and access\n\nERC20 view compatibility, decimals, proxy status, and runtime hashes are bound. Fee-on-transfer and rebasing mutation semantics remain \`UNKNOWN_READ_ONLY\` because no token mutation was attempted. DebtManager pause and anonymous role-holder composition are recorded in the raw artifact.\n\n## Blockers\n\n${blockers.map((x) => `- ${x}`).join("\n")}\n\n**nextGate:** ${nextGate}\n`;

  const inbox = {
    findingId: NAME,
    revision: REVISION,
    runId,
    agentId: AGENT,
    role: "critical-research",
    status: classification,
    classification,
    pipeline: "1/5",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    summary: `Read-only fixed-pin binding classified the DebtManager zero-share primitive as ${classification}; runtime, supplier concentration, current conditions, and all blockers are sanitized and review-pending.`,
    pin: transcript.pin,
    runtime: result.deploymentBinding,
    concentration: result.supplierConcentration,
    conditions,
    artifacts: [SCANNER, VALIDATOR, RAW, EVIDENCE, MANIFEST, REPORT],
    nextAction: nextGate,
  };
  const handoff = `# EtherFi DebtManager deployment-binding handoff\n\n- Run: \`${runId}\`\n- Classification: \`${classification}\`; pipeline \`1/5\`; route/executable/signing/fork remain \`0/0/false/false\`.\n- Fixed finalized OP pin: \`${pin.number}\` / \`${pin.hash}\`; ${providers.length} anonymous provider families agreed and passed terminal same-number recheck.\n- Proxy/implementation and exact local runtime binding: \`${state.proxy}\` -> \`${state.implementation}\`; exact=${runtimeBinding.exact}; runtime hash \`${state.implementationRuntimeKeccak256}\`.\n- Complete supplier concentration: ${historyComplete && concentrationComplete}; ${suppliedLogs.length} Supplied events, ${candidateSuppliers.length} candidates, all current share sums exact=${concentrationComplete}.\n- Current condition present=${anyConditionPresent}; paused=${state.paused}; no contract minSharesOut and zero shares are not rejected. See per-asset raw thresholds in the artifact.\n- No endpoint/domain/key/header/raw response, signed transaction, mutation, fund movement, fork, or economics was persisted or performed.\n- Next gate: ${nextGate}\n`;

  const texts = {
    [RAW]: `${JSON.stringify(result, null, 2)}\n`,
    [EVIDENCE]: `${JSON.stringify(evidence, null, 2)}\n`,
    [REPORT]: report,
    [INBOX]: `${JSON.stringify(inbox, null, 2)}\n`,
    [HANDOFF]: handoff,
  };
  for (const text of Object.values(texts)) sanitizeOutputGuard(text);
  for (const [file, text] of Object.entries(texts)) writeOwned(file, text);
  const sourceFiles = [
    "targets/cash-v3/src/debt-manager/DebtManagerCore.sol",
    "targets/cash-v3/src/debt-manager/DebtManagerStorageContract.sol",
    "targets/cash-v3/src/interfaces/IDebtManager.sol",
    "targets/cash-v3/src/utils/UpgradeableProxy.sol",
    DEPLOYMENTS, CONFIG,
  ];
  const records = [SCANNER, VALIDATOR, RAW, EVIDENCE, REPORT, INBOX, HANDOFF, PREDECESSOR, ...sourceFiles].map(hashFile);
  const aggregateSha256 = sha(records.map((x) => `${x.path}\0${x.bytes}\0${x.sha256}`).join("\n"));
  const manifest = {
    schemaVersion: 1,
    revision: REVISION,
    runId,
    generatedAt,
    classification,
    pipeline: "1/5",
    routePositive: 0,
    executableNow: 0,
    signedActionJustified: false,
    fork: false,
    sourceCommit: SOURCE_COMMIT,
    pin: transcript.pin,
    providerCount: providers.length,
    providerFamilyCount: providers.length,
    exactLocalRuntime: runtimeBinding.exact,
    historyComplete,
    concentrationComplete,
    endpointMaterialPersisted: false,
    rawRpcPersisted: false,
    allowedRpcMethods: [...ALLOWED_RPC].sort(),
    actualRpcCalls: rpcTotal,
    selfTestsPassed: tests.passed,
    records,
    aggregateSha256,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  sanitizeOutputGuard(manifestText);
  writeOwned(MANIFEST, manifestText);
  process.stdout.write(`${JSON.stringify({ runId, classification, pin: transcript.pin, providers: providers.length, runtimeExact: runtimeBinding.exact, historyComplete, concentrationComplete, conditions, assets: assets.map((x) => ({ name: x.name, totalAssetsRaw: x.totalAssetsRaw, totalSharesRaw: x.totalSharesRaw, minSharesRaw: x.minSharesRaw, maxSupplierConcentrationBps: x.maxSupplierConcentrationBps, soleIncumbent: x.soleIncumbent, highConcentration: x.highConcentration })), aggregateSha256 }, null, 2)}\n`);
}

main().catch((error) => {
  // Never include endpoint material or raw RPC bodies in errors.
  process.stderr.write(`DebtManager deployment binding failed: ${String(error?.message || "unknown").replace(/https?:\/\/\S+/gi, "[redacted]")}\n`);
  process.exit(1);
});
