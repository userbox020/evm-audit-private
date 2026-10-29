#!/usr/bin/env node
// Read-only Lorenzo sUSD1+ same-epoch exit probe.
// Uses eth_call only; no signatures, sends, forks, or persisted state changes.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const INPUT = path.join(WORKSPACE, "reports", "raw", "fast", "lorenzo-susd1plus-live.json");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "lorenzo-same-epoch-exit-probe.json");
const QUIET = process.argv.includes("--quiet");
const TIMEOUT_MS = 15_000;
const SKIP_RPC_INVENTORY = process.env.LORENZO_SKIP_RPC_INVENTORY === "1";
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const CHAINS = {
  ethereum: {
    chainId: 1,
    vault: "0x8F18f2C97d2f5EC0e1d5B91c1D2ce245a9151972",
    fallbacks: ["https://ethereum-rpc.publicnode.com"],
    probeAccounts: [],
  },
  bsc: {
    chainId: 56,
    vault: "0x4F2760B32720F013E900DC92F65480137391199b",
    fallbacks: ["https://bsc-dataseed.binance.org"],
    probeAccounts: [
      { source: "PancakeSwap V3 sUSD1+/USD1 0.05%", address: "0x479a86165f288C9CE7bB4238258584B259EB5fc7" },
      { source: "PancakeSwap V3 sUSD1+/USDT 0.05%", address: "0xd2144852d15331F8551fD310F16fD3c070dBC898" },
    ],
  },
};

const RAW_CALLS = {
  currentUnitNav: { name: "getCurrentUnitNav()", selector: "0x4924afaf", outputs: ["uint256"] },
  settlementPeriod: { name: "settlementPeriod()", selector: "0x0f1071be", outputs: ["uint256"] },
  unsettledWithdrawShares: { name: "unsettledWithdrawShares()", selector: "0x96ffc0f5", outputs: ["uint256"] },
  minWithdrawAmount: { name: "minWithdrawAmount()", selector: "0x457e1a49", outputs: ["uint256"] },
  paused: { name: "paused()", selector: "0x5c975abb", outputs: ["bool"] },
  transferable: { name: "transferable()", selector: "0x92ff0d31", outputs: ["bool"] },
};

const PERIOD_CALLS = {
  withdrawShares: { name: "periodWithdrawShares(uint256)", selector: "0x48cf1f21", outputs: ["uint256"] },
  unitNav: { name: "periodUnitNav(uint256)", selector: "0xaea5b21d", outputs: ["uint256"] },
};

const ERC4626_VIEWS = [
  { name: "asset()", signature: "asset() view returns (address)", args: [] },
  { name: "totalAssets()", signature: "totalAssets() view returns (uint256)", args: [] },
  { name: "convertToAssets(uint256)", signature: "convertToAssets(uint256) view returns (uint256)", args: [10n ** 18n] },
  { name: "maxWithdraw(address)", signature: "maxWithdraw(address) view returns (uint256)", args: [PROBE_FROM] },
  { name: "maxRedeem(address)", signature: "maxRedeem(address) view returns (uint256)", args: [PROBE_FROM] },
  { name: "previewWithdraw(uint256)", signature: "previewWithdraw(uint256) view returns (uint256)", args: [10n ** 18n] },
  { name: "previewRedeem(uint256)", signature: "previewRedeem(uint256) view returns (uint256)", args: [10n ** 18n] },
];

const ACCOUNT_VIEWS = [
  { name: "getBalanceDetails(address)", signature: "getBalanceDetails(address) view returns (uint256 totalShares,uint256 frozenShares,uint256 withdrawingShares)" },
  { name: "getOngoingWithdrawShares(address)", signature: "getOngoingWithdrawShares(address) view returns (uint256)" },
  { name: "getUsableShares(address)", signature: "getUsableShares(address) view returns (uint256)" },
  { name: "frozenShares(address)", signature: "frozenShares(address) view returns (uint256)" },
];

const ACCOUNT_PERIOD_VIEWS = [
  { name: "withdrewRequests(address,uint128)", signature: "withdrewRequests(address,uint128) view returns (uint256 requestShares,uint256 targetPeriod,uint256 requestTimestamp,uint256 executedTimestamp)" },
  { name: "pendingShares(address,uint128)", signature: "pendingShares(address,uint128) view returns (uint256)" },
  { name: "confirmedShares(address,uint128)", signature: "confirmedShares(address,uint128) view returns (uint256)" },
];

const BALANCE_OF_I = new ethers.Interface(["function balanceOf(address) view returns (uint256)"]);
const TRANSFER_I = new ethers.Interface(["function transfer(address,uint256) returns (bool)"]);
const ABI = ethers.AbiCoder.defaultAbiCoder();

function readJson(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function loadRpcUrls() {
  if (SKIP_RPC_INVENTORY) return [];
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rawRpcCall(url, method, params = [], timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveRpc(chain) {
  const candidates = [...loadRpcUrls(), ...(chain.fallbacks || [])];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const id = Number(BigInt(await rawRpcCall(url, "eth_chainId", [], 6000)));
      if (id === chain.chainId) return url;
    } catch (_) {
      // Never print or persist RPC URLs.
    }
  }
  return null;
}

function strip0x(value) {
  return String(value || "").replace(/^0x/i, "");
}

function addressFromWord(word) {
  if (!word || word === "0x") return null;
  try {
    if (BigInt(word) === 0n) return null;
  } catch (_) {
    return null;
  }
  return ethers.getAddress("0x" + strip0x(word).slice(-40));
}

function serialize(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === "object" && typeof value.length === "number") return Array.from(value).map(serialize);
  return value;
}

function wordValues(data) {
  const hex = strip0x(data);
  const words = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) words.push(BigInt("0x" + hex.slice(i, i + 64)).toString());
  return words;
}

function firstOutput(call) {
  return call?.decodedOutput?.[0] ?? null;
}

function firstBigInt(call) {
  const value = firstOutput(call);
  if (value === null || value === undefined) return null;
  try { return BigInt(value); } catch (_) { return null; }
}

function firstBool(call) {
  const value = firstOutput(call);
  return typeof value === "boolean" ? value : null;
}

function decodeErrorData(data) {
  if (!data || typeof data !== "string" || !data.startsWith("0x")) return { revertSelector: null, decodedError: null };
  const revertSelector = data.length >= 10 ? data.slice(0, 10) : null;
  try {
    if (revertSelector === "0x08c379a0") {
      const [reason] = ABI.decode(["string"], "0x" + strip0x(data).slice(8));
      return { revertSelector, decodedError: `Error(${JSON.stringify(reason)})` };
    }
    if (revertSelector === "0x4e487b71") {
      const [code] = ABI.decode(["uint256"], "0x" + strip0x(data).slice(8));
      return { revertSelector, decodedError: `Panic(${code.toString()})` };
    }
  } catch (_) {
    // Keep raw selector only.
  }
  return { revertSelector, decodedError: null };
}

function extractErrorData(err) {
  const direct = err?.data || err?.error?.data || err?.info?.error?.data;
  if (typeof direct === "string" && direct !== "0x") return direct;
  if (direct && typeof direct.data === "string") return direct.data;
  return null;
}

function errorCall(err, from) {
  const data = extractErrorData(err);
  const decoded = decodeErrorData(data);
  const reason = err?.reason || err?.shortMessage || err?.message || "execution reverted";
  return {
    ok: false,
    from,
    error: decoded.decodedError ? `execution reverted: ${decoded.decodedError.replace(/^Error\("|"\)$/g, "")}` : reason,
    revertSelector: decoded.revertSelector,
    decodedError: decoded.decodedError,
    data: data || "0x",
  };
}

async function callFunction(provider, to, spec, args = spec.args || [], from = PROBE_FROM) {
  const iface = new ethers.Interface([`function ${spec.signature}`]);
  const fragment = iface.fragments[0];
  const data = iface.encodeFunctionData(fragment, args);
  try {
    const raw = await provider.call({ to, from, data });
    const decoded = iface.decodeFunctionResult(fragment, raw);
    return {
      ok: true,
      from,
      dataBytes: (strip0x(raw).length / 2),
      decodedOutput: serialize(decoded),
      wordValues: wordValues(raw),
      revertSelector: null,
      decodedError: null,
    };
  } catch (err) {
    return errorCall(err, from);
  }
}

async function callRaw(provider, to, spec, args = [], from = PROBE_FROM) {
  const data = spec.selector + (args.length ? ABI.encode(args.map((a) => a.type), args.map((a) => a.value)).slice(2) : "");
  try {
    const raw = await provider.call({ to, from, data });
    const decoded = ABI.decode(spec.outputs, raw);
    return {
      ok: true,
      from,
      dataBytes: (strip0x(raw).length / 2),
      decodedOutput: serialize(decoded),
      wordValues: wordValues(raw),
      revertSelector: null,
      decodedError: null,
    };
  } catch (err) {
    return errorCall(err, from);
  }
}

async function tokenBalance(provider, token, account) {
  try {
    const raw = await provider.call({ to: token, data: BALANCE_OF_I.encodeFunctionData("balanceOf", [account]) });
    return BALANCE_OF_I.decodeFunctionResult("balanceOf", raw)[0];
  } catch (_) {
    return null;
  }
}

async function contractMeta(provider, address) {
  const [code, implSlot, adminSlot] = await Promise.all([
    provider.getCode(address).catch(() => "0x"),
    provider.getStorage(address, IMPL_SLOT).catch(() => null),
    provider.getStorage(address, ADMIN_SLOT).catch(() => null),
  ]);
  const implementation = addressFromWord(implSlot);
  return {
    address,
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? strip0x(code).length / 2 : 0,
    eip1967Implementation: implementation,
    eip1967Admin: addressFromWord(adminSlot),
  };
}

async function findShareHolder(provider, cfg) {
  let best = null;
  for (const row of [{ source: "probe-address-no-known-live-share-balance", address: PROBE_FROM }, ...(cfg.probeAccounts || [])]) {
    const balance = await tokenBalance(provider, cfg.vault, row.address);
    if (balance === null) continue;
    const candidate = { ...row, balanceRaw: balance.toString(), balance: Number(ethers.formatUnits(balance, 18)) };
    if (!best || balance > BigInt(best.balanceRaw || 0)) best = candidate;
  }
  return best;
}

async function inspectChain(chainName, cfg) {
  const rpcUrl = await resolveRpc(cfg);
  if (!rpcUrl) return { chain: chainName, chainId: cfg.chainId, rpcResolved: false, vault: cfg.vault, error: "missing-rpc" };

  const provider = new ethers.JsonRpcProvider(rpcUrl, cfg.chainId, { staticNetwork: true });
  const blockNumber = await provider.getBlockNumber();
  const contract = await contractMeta(provider, cfg.vault);
  const implementation = contract.eip1967Implementation ? await contractMeta(provider, contract.eip1967Implementation) : null;

  const views = [];
  for (const spec of ERC4626_VIEWS) {
    views.push({ name: spec.name, erc4626: true, call: await callFunction(provider, cfg.vault, spec) });
  }
  const customViews = {};
  for (const [key, spec] of Object.entries(RAW_CALLS)) {
    const call = await callRaw(provider, cfg.vault, spec);
    views.push({ name: spec.name, erc4626: false, call });
    customViews[key] = call;
  }

  const minWithdrawAmount = firstBigInt(customViews.minWithdrawAmount) || 1n;
  const settlementPeriod = firstBigInt(customViews.settlementPeriod);
  const unsettledWithdrawShares = firstBigInt(customViews.unsettledWithdrawShares) || 0n;
  const paused = firstBool(customViews.paused);
  const transferable = firstBool(customViews.transferable);
  const assetView = views.find((v) => v.name === "asset()")?.call;
  const underlying = assetView?.ok ? firstOutput(assetView) : ZERO;
  const shareHolder = await findShareHolder(provider, cfg);
  const actionFrom = shareHolder?.balanceRaw && BigInt(shareHolder.balanceRaw) >= minWithdrawAmount ? shareHolder.address : PROBE_FROM;
  const actionAmount = shareHolder?.balanceRaw ? (BigInt(shareHolder.balanceRaw) < minWithdrawAmount ? BigInt(shareHolder.balanceRaw) : minWithdrawAmount) : 1n;

  const accounts = [PROBE_FROM, actionFrom].filter((v, i, arr) => v && arr.indexOf(v) === i);
  const accountViews = [];
  for (const account of accounts) {
    for (const spec of ACCOUNT_VIEWS) {
      accountViews.push({ account, name: spec.name, call: await callFunction(provider, cfg.vault, spec, [account]) });
    }
  }

  const periods = [];
  if (settlementPeriod !== null) {
    for (const p of [settlementPeriod - 2n, settlementPeriod - 1n, settlementPeriod, settlementPeriod + 1n]) {
      if (p > 0n && !periods.includes(p)) periods.push(p);
    }
  }

  const periodRows = [];
  for (const period of periods) {
    periodRows.push({
      period: period.toString(),
      withdrawShares: await callRaw(provider, cfg.vault, PERIOD_CALLS.withdrawShares, [{ type: "uint256", value: period }]),
      unitNav: await callRaw(provider, cfg.vault, PERIOD_CALLS.unitNav, [{ type: "uint256", value: period }]),
    });
  }

  const accountPeriodRows = [];
  for (const account of accounts) {
    for (const period of periods) {
      for (const spec of ACCOUNT_PERIOD_VIEWS) {
        accountPeriodRows.push({ account, period: period.toString(), name: spec.name, call: await callFunction(provider, cfg.vault, spec, [account, period]) });
      }
    }
  }

  const actionSpecs = [
    { name: "withdraw(uint256,address,address)", signature: "withdraw(uint256,address,address) returns (uint256)", args: [actionAmount, actionFrom, actionFrom], erc4626: true, queueLikely: false, from: actionFrom },
    { name: "redeem(uint256,address,address)", signature: "redeem(uint256,address,address) returns (uint256)", args: [actionAmount, actionFrom, actionFrom], erc4626: true, queueLikely: false, from: actionFrom },
    { name: "withdraw(uint256)", signature: "withdraw(uint256) returns (uint256)", args: [actionAmount], erc4626: false, queueLikely: false, from: actionFrom },
    { name: "redeem(uint256)", signature: "redeem(uint256) returns (uint256)", args: [actionAmount], erc4626: false, queueLikely: false, from: actionFrom },
    { name: "requestWithdraw(uint256)", signature: "requestWithdraw(uint256) returns (uint128)", args: [actionAmount], erc4626: false, queueLikely: true, from: actionFrom },
    { name: "withdraw(uint128)", signature: "withdraw(uint128)", args: [settlementPeriod || 1n], erc4626: false, queueLikely: true, from: actionFrom },
    { name: "deposit(address,uint256)", signature: "deposit(address,uint256) returns (uint256)", args: [underlying || ZERO, actionAmount], erc4626: false, queueLikely: true, from: PROBE_FROM },
    { name: "directDeposit(address,uint256)", signature: "directDeposit(address,uint256) returns (uint256)", args: [underlying || ZERO, actionAmount], erc4626: false, queueLikely: true, from: PROBE_FROM },
    { name: "supply(address,uint256)", signature: "supply(address,uint256) returns (uint256)", args: [underlying || ZERO, actionAmount], erc4626: false, queueLikely: false, from: PROBE_FROM },
  ];

  const actions = [];
  for (const spec of actionSpecs) {
    actions.push({ name: spec.name, erc4626: spec.erc4626, queueLikely: spec.queueLikely, from: spec.from, call: await callFunction(provider, cfg.vault, spec, spec.args, spec.from) });
  }

  const transferAmount = actionAmount > 0n ? actionAmount : 1n;
  let shareTransfer = { from: actionFrom, source: shareHolder?.source || null, balance: shareHolder?.balance ?? null, call: null };
  try {
    const raw = await provider.call({
      to: cfg.vault,
      from: actionFrom,
      data: TRANSFER_I.encodeFunctionData("transfer", [PROBE_FROM, transferAmount]),
    });
    const decoded = TRANSFER_I.decodeFunctionResult("transfer", raw);
    shareTransfer.call = {
      ok: true,
      from: actionFrom,
      dataBytes: strip0x(raw).length / 2,
      decodedOutput: serialize(decoded),
      wordValues: wordValues(raw),
      revertSelector: null,
      decodedError: null,
    };
  } catch (err) {
    shareTransfer.call = errorCall(err, actionFrom);
  }

  const erc4626ViewsOk = views.filter((v) => v.erc4626 && v.call.ok).map((v) => v.name);
  const erc4626ExitOk = actions.filter((v) => v.erc4626 && v.call.ok).map((v) => v.name);
  const nonQueueExitOk = actions.filter((v) => !v.erc4626 && !v.queueLikely && v.call.ok).map((v) => v.name);
  const requestWithdraw = actions.find((v) => v.name === "requestWithdraw(uint256)");
  const requestWithdrawPublicObserved = Boolean(requestWithdraw?.call?.ok || /Insufficient balance|insufficient/i.test(requestWithdraw?.call?.decodedError || requestWithdraw?.call?.error || ""));
  const periodWithdrawSignals = periodRows.some((r) => (firstBigInt(r.withdrawShares) || 0n) > 0n);
  const accountQueueSignals = accountViews.some((r) => {
    const out = r.call?.decodedOutput || [];
    return out.some((v) => {
      try { return BigInt(v) > 0n; } catch (_) { return false; }
    });
  });
  const queueSignals = unsettledWithdrawShares > 0n || periodWithdrawSignals || accountQueueSignals || Boolean(requestWithdraw?.call?.ok);
  const queueClaimTransferProven = false;
  const sameEpochPublicExitProven = Boolean((erc4626ExitOk.length > 0 || nonQueueExitOk.length > 0) && !queueSignals);
  const blockers = [];
  if (erc4626ViewsOk.length === 0) blockers.push("No ERC4626-style same-epoch NAV exit views are live");
  if (erc4626ExitOk.length === 0 && nonQueueExitOk.length === 0) blockers.push("No public same-epoch redeem/withdraw eth_call succeeded");
  if (queueSignals) blockers.push("Withdrawal surface is period-queue based");
  if (!queueClaimTransferProven) blockers.push("No transferable withdrawal-queue claim is proven");
  if (paused === true) blockers.push("Vault is paused");
  if (transferable === false) blockers.push("sUSD1+ transferability is disabled");

  return {
    chain: chainName,
    chainId: cfg.chainId,
    rpcResolved: true,
    blockNumber,
    vault: cfg.vault,
    implementation: contract.eip1967Implementation,
    contract,
    implementationMeta: implementation,
    probeAccounts: accounts,
    selectedShareHolder: shareHolder,
    summary: {
      erc4626ViewsOk,
      erc4626ExitOk,
      customExitOk: [...nonQueueExitOk, ...(requestWithdraw?.call?.ok ? ["requestWithdraw(uint256)"] : [])],
      requestWithdrawOk: Boolean(requestWithdraw?.call?.ok),
      requestWithdrawPublicObserved,
      queueSignals,
      shareTransferOk: Boolean(shareTransfer.call?.ok),
      queueClaimTransferProven,
      sameEpochPublicExitProven,
      routePositive: sameEpochPublicExitProven ? 1 : 0,
      blocker: sameEpochPublicExitProven ? null : "No public same-epoch ERC4626-style NAV exit; request/withdraw surface is period-queue based and queue claims are not proven transferable",
    },
    views,
    accountViews,
    periodRows,
    accountPeriodRows,
    actions,
    shareTransfer,
    blockers,
  };
}

function summarize(results) {
  const scanned = results.filter((r) => r.rpcResolved);
  const sameEpochPublicExitProven = scanned.some((r) => r.summary?.sameEpochPublicExitProven);
  const requestWithdrawPublicObserved = scanned.some((r) => r.summary?.requestWithdrawPublicObserved);
  const queueClaimTransferProven = scanned.some((r) => r.summary?.queueClaimTransferProven);
  return {
    chainsScanned: results.length,
    chainsResolved: scanned.length,
    sameEpochPublicExitProven,
    requestWithdrawPublicObserved,
    queueClaimTransferProven,
    routePositive: sameEpochPublicExitProven ? 1 : 0,
    signedActionJustified: false,
    blocker: sameEpochPublicExitProven
      ? null
      : "Same-epoch public NAV exit remains unproven; requestWithdraw/withdraw is queue-based and no transferable queue claim is proven",
  };
}

async function main() {
  const input = readJson(INPUT, null);
  const results = [];
  for (const [chainName, cfg] of Object.entries(CHAINS)) {
    if (!QUIET) console.log(`Probing Lorenzo ${chainName} exit semantics...`);
    results.push(await inspectChain(chainName, cfg));
  }
  const summary = summarize(results);
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/probe-lorenzo-same-epoch-exit.js",
    scope: "Read-only Lorenzo sUSD1+ same-epoch NAV exit probe",
    safety: {
      rpcInventorySkipped: SKIP_RPC_INVENTORY,
      rpcInventoryRead: !SKIP_RPC_INVENTORY,
      publicFallbackRpcAllowed: true,
      rpcUrlsStored: false,
      signedActions: false,
      stateChangingCalls: false,
      simulationsViaEthCallOnly: true,
      routePositive: summary.routePositive > 0,
      signedActionJustified: false,
    },
    input: path.relative(WORKSPACE, INPUT),
    inputGeneratedAt: input?.generatedAt || null,
    probeFrom: PROBE_FROM,
    summary,
    verifiedAbiEvidence: [
      "requestWithdraw(uint256) returns (uint128 requestId)",
      "withdraw(uint128 requestId)",
      "getBalanceDetails(address) returns (totalShares,frozenShares,withdrawingShares)",
      "withdrewRequests(address,uint128) returns (requestShares,targetPeriod,requestTimestamp,executedTimestamp)",
      "getOngoingWithdrawShares(address), getUsableShares(address), frozenShares(address)",
      "pendingShares(address,uint128), confirmedShares(address,uint128)",
    ],
    results,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  if (!QUIET) {
    console.log(`Lorenzo exit probe: sameEpoch=${summary.sameEpochPublicExitProven} requestWithdrawObserved=${summary.requestWithdrawPublicObserved} routePositive=${summary.routePositive}`);
    console.log(`wrote ${OUT}`);
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
