#!/usr/bin/env node
// Fork transaction test harness for Stader (local-only defensive validation).

const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { loadRpcUrls, getOrigin } = require("./shared-rpc");

const WORKSPACE = path.resolve(__dirname, "..");
const IN_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "stader-full-test.json");
const OUT_JSON = path.join(WORKSPACE, "reports", "raw", "fast", "stader-fork-transaction-test.json");
const OUT_MD = path.join(WORKSPACE, "reports", "stader-fork-transaction-test.md");

const QUIET = process.argv.includes("--quiet");
const OUT_JSON_REL = "reports/raw/fast/stader-fork-transaction-test.json";
const OUT_MD_REL = "reports/stader-fork-transaction-test.md";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ONE_WEI = 1n;
const PORT = Number(process.env.STADER_FORK_PORT || 18545);
const FORK_RPC_LOCAL = `http://127.0.0.1:${PORT}`;
const RPC_TIMEOUT_MS = 12_000;

const TARGET_FUNCS = [
  {
    name: "redeem",
    signature: "redeem(uint256,address,address)",
    selector: "0xba087652",
    argTypes: ["uint256", "address", "address"],
    buildArgs: (ctx) => [ONE_WEI, ctx.receiver, ctx.sender],
    category: "vault",
  },
  {
    name: "withdraw",
    signature: "withdraw(uint256,address,address)",
    selector: "0xb460af94",
    argTypes: ["uint256", "address", "address"],
    buildArgs: (ctx) => [ONE_WEI, ctx.receiver, ctx.sender],
    category: "vault",
  },
  {
    name: "claim",
    signature: "claim()",
    selector: "0x4e71d92d",
    argTypes: [],
    buildArgs: () => [],
    category: "vault",
  },
  {
    name: "claim",
    signature: "claim(address,address,address)",
    selector: "0x2cd1b113",
    argTypes: ["address", "address", "address"],
    buildArgs: (ctx) => [ctx.receiver, ctx.receiver, ctx.sender],
    category: "vault",
    optional: true,
  },
  {
    name: "unstake",
    signature: "unstake(uint256)",
    selector: "0x2e17de78",
    argTypes: ["uint256"],
    buildArgs: () => [ONE_WEI],
    category: "vault",
  },
  {
    name: "instantRedeem",
    signature: "instantRedeem(uint256,address,address)",
    selector: "0x77a84317",
    argTypes: ["uint256", "address", "address"],
    buildArgs: (ctx) => [ONE_WEI, ctx.receiver, ctx.sender],
    category: "vault",
    optional: true,
  },
];

function log(...args) {
  if (!QUIET) {
    console.log(...args);
  }
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function normalizeAddress(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(raw)) return null;
  return raw;
}

function uniq(valueList) {
  const seen = new Set();
  const out = [];
  for (const value of valueList) {
    const normalized = String(value || "");
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function toQuantity(value) {
  const bn = BigInt(value);
  return `0x${bn.toString(16)}`;
}

function zeroAddressOr(input, fallback = ZERO_ADDRESS) {
  const addr = normalizeAddress(input);
  return addr || fallback;
}

function padAddress(addr) {
  const clean = String(addr).toLowerCase().replace(/^0x/, "");
  return clean.padStart(64, "0");
}

function encodeArg(value, type) {
  if (type === "address") {
    return padAddress(zeroAddressOr(value));
  }
  if (type === "uint256") {
    return BigInt(value).toString(16).padStart(64, "0");
  }
  return String(BigInt(value || 0)).padStart(64, "0");
}

function buildData(selector, args, argTypes) {
  let payload = selector.toLowerCase().replace(/^0x/, "");
  for (let i = 0; i < args.length; i += 1) {
    payload += encodeArg(args[i], argTypes[i] || "uint256");
  }
  return `0x${payload}`;
}

function decodeWord(raw, index = 0) {
  const clean = String(raw || "0x").toLowerCase().replace(/^0x/, "");
  if (!clean || clean.length < (index + 1) * 64) return null;
  const start = index * 64;
  const end = start + 64;
  return clean.slice(start, end);
}

function decodeUint256(raw) {
  if (!raw) return null;
  const word = decodeWord(raw, 0);
  if (!word) return null;
  return BigInt(`0x${word}`);
}

function decodeAddress(raw) {
  const word = decodeWord(raw, 0);
  if (!word) return null;
  const addr = `0x${word.slice(-40)}`;
  return normalizeAddress(addr);
}

function sanitizeError(error) {
  if (!error) return null;
  if (typeof error === "string") return error.slice(0, 500);
  if (typeof error.message === "string") return error.message.slice(0, 500);
  if (error.error) {
    const code = error.error.code || null;
    if (error.error.message) return `${code ? `${code}: ` : ""}${error.error.message}`.slice(0, 500);
  }
  return JSON.stringify(error).slice(0, 500);
}

function isLocalRpc(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch (_) {
    return false;
  }
}

async function rpcCall(url, method, params = [], timeoutMs = RPC_TIMEOUT_MS, allowRedirect = true) {
  const headers = { "content-type": "application/json" };
  const origin = getOrigin(url);
  if (origin) headers.origin = origin;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });

    const payload = await res.json();
    if (payload.error) return { ok: false, error: payload.error.message || "rpc-error", raw: payload };
    return { ok: true, result: payload.result, raw: payload };
  } catch (err) {
    const message = sanitizeError(err);
    if (allowRedirect && isLocalRpc(url) && /ENOTFOUND|ECONNREFUSED|connect/i.test(message || "")) {
      return { ok: false, error: message || "rpc-connection-error", raw: null };
    }
    return { ok: false, error: message || "rpc-error", raw: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function rpcPost(url, method, params = [], timeoutMs = RPC_TIMEOUT_MS) {
  if (!isLocalRpc(url)) {
    throw new Error("Blocked non-local RPC usage for transaction path");
  }
  return rpcCall(url, method, params, timeoutMs);
}

function extractRevertFromPayload(payload) {
  if (!payload || !payload.error) return null;
  return payload.error.data || payload.error.message || null;
}

async function waitForFork(url, tries = 60, delayMs = 500) {
  for (let i = 0; i < tries; i += 1) {
    const chain = await rpcCall(url, "eth_chainId", []);
    if (chain.ok && chain.result) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function resolveForkableEndpoint() {
  const candidates = uniq(loadRpcUrls()).map((entry) => String(entry || "").trim()).filter(Boolean);
  const queue = [];

  for (const url of candidates) {
    const lower = url.toLowerCase();
    if (!/^https?:\/\//.test(lower)) continue;
    queue.push(url);
  }

  return { candidates: queue };
}

async function resolveEthereumForkEndpoint() {
  const { candidates } = resolveForkableEndpoint();
  for (const url of candidates) {
    const chainCheck = await rpcCall(url, "eth_chainId", []);
    if (!chainCheck.ok || !chainCheck.result) continue;
    try {
      const parsed = Number(BigInt(chainCheck.result));
      if (parsed === 1) return url;
    } catch (_) {
      // Ignore parsing failures.
    }
  }
  return null;
}

function resolveAnvilCommand() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    "anvil",
    path.join(home, ".foundry", "bin", "anvil.exe"),
    path.join(home, ".foundry", "bin", "anvil"),
  ];

  for (const command of candidates) {
    if (!command) continue;
    if (path.extname(command) && !fs.existsSync(command)) {
      continue;
    }
    try {
      const test = cp.spawnSync(command, ["--version"], { stdio: "ignore", windowsHide: true });
      if (!test.error) return command;
    } catch (_) {
      continue;
    }
  }

  const fallback = "anvil";
  try {
    const test = cp.spawnSync(fallback, ["--version"], { stdio: "ignore", windowsHide: true });
    if (!test.error) return fallback;
  } catch (_) {}
  return null;
}

async function startAnvil(forkUrl) {
  const command = resolveAnvilCommand();
  if (!command) {
    return { ok: false, error: "anvil binary missing", child: null, providerUrl: FORK_RPC_LOCAL };
  }

  const args = [
    "--fork-url",
    forkUrl,
    "--port",
    String(PORT),
    "--chain-id",
    "1",
  ];

  const child = cp.spawn(command, args, {
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
  });

  return { ok: true, command, child, providerUrl: FORK_RPC_LOCAL };
}

async function stopAnvil(handle) {
  if (!handle || !handle.child) return;
  try {
    if (!handle.child.killed) handle.child.kill("SIGTERM");
  } catch (_) {}
  setTimeout(() => {
    try {
      if (!handle.child.killed) handle.child.kill("SIGKILL");
    } catch (_) {}
  }, 1500);
}

function collectTargets(staderData, fallbackTargets) {
  const out = new Map();

  const push = (addr, source) => {
    const normalized = normalizeAddress(addr);
    if (!normalized) return;
    if (!out.has(normalized)) {
      out.set(normalized, {
        address: normalized,
        source,
      });
    }
  };

  if (staderData?.target?.sampleAddresses) {
    for (const row of staderData.target.sampleAddresses) {
      push(row, "stader-full-test-sample");
    }
  }

  const rows = Array.isArray(staderData?.liveProbes) ? staderData.liveProbes : [];
  for (const row of rows) {
    if (Number(row?.chainId) !== 1) continue;
    if (row?.codePresent !== true) continue;
    push(row.address, `liveProbe:${row.source || "unknown"}`);
  }

  if (!out.size && Array.isArray(fallbackTargets)) {
    for (const row of fallbackTargets) push(row, "fallback-target");
  }

  return Array.from(out.values());
}

async function getAccounts(rpcUrl) {
  const result = await rpcPost(rpcUrl, "eth_accounts", []);
  if (!result.ok || !Array.isArray(result.result)) return [];
  return result.result
    .map((addr) => normalizeAddress(addr))
    .filter(Boolean);
}

async function getBalance(rpcUrl, address) {
  const result = await rpcPost(rpcUrl, "eth_getBalance", [address, "latest"]);
  if (!result.ok) return null;
  try {
    return BigInt(result.result);
  } catch (_) {
    return null;
  }
}

async function getEthCallResult(rpcUrl, to, data) {
  const result = await rpcPost(rpcUrl, "eth_call", [{ to, data }, "latest"]);
  if (!result.ok) {
    return { ok: false, error: result.error || "eth_call-failed", raw: null };
  }
  return { ok: true, raw: result.result };
}

async function readTokenContext(rpcUrl, target) {
  const out = {
    token: null,
    tokenDecimals: null,
    tokenSymbol: null,
    assetProbeError: null,
    decimalsProbeError: null,
  };

  const assetCall = await getEthCallResult(rpcUrl, target, "0x38d52e0f");
  if (assetCall.ok) {
    const token = decodeAddress(assetCall.raw);
    if (token && token !== ZERO_ADDRESS) {
      out.token = token;
    }
  } else {
    out.assetProbeError = assetCall.error;
  }

  if (out.token) {
    const symbolCall = await getEthCallResult(rpcUrl, out.token, "0x95d89b41");
    if (symbolCall.ok) {
      const symbolRaw = symbolCall.raw;
      if (symbolRaw && /^0x[0-9a-f]{64,}$/i.test(symbolRaw)) {
        // Conservative best-effort UTF-8 decode for short string metadata.
        try {
          const bytes = symbolRaw.replace(/^0x/, "");
          const len = Number.parseInt(bytes.slice(128, 192) || "0", 16);
          const payload = bytes.slice(192, 192 + len * 2);
          out.tokenSymbol = Buffer.from(payload || "", "hex").toString("utf8").replace(/\u0000/g, "").trim() || null;
        } catch (_) {}
      }
    }

    const decCall = await getEthCallResult(rpcUrl, out.token, "0x313ce567");
    if (decCall.ok) {
      const dec = decodeUint256(decCall.raw);
      if (dec !== null) out.tokenDecimals = dec;
    } else {
      out.decimalsProbeError = decCall.error;
    }
  }

  return out;
}

function renderTokenBalanceKey(tokenAddress) {
  return `${(tokenAddress || "").toLowerCase()}`;
}

async function readTokenBalance(rpcUrl, tokenAddr, holder) {
  if (!tokenAddr || !holder) return null;
  const data = `0x70a08231${padAddress(holder)}`;
  const result = await getEthCallResult(rpcUrl, tokenAddr, data);
  if (!result.ok) return null;
  return decodeUint256(result.raw);
}

async function snapshotState(rpcUrl) {
  const snap = await rpcPost(rpcUrl, "evm_snapshot", []);
  return snap.ok ? snap.result : null;
}

async function revertState(rpcUrl, id) {
  if (!id) return { ok: false, error: "missing-snapshot" };
  return rpcPost(rpcUrl, "evm_revert", [id]);
}

async function estimateGas(rpcUrl, txObj) {
  const estimate = await rpcPost(rpcUrl, "eth_estimateGas", [txObj]);
  return estimate.ok ? estimate.result : null;
}

async function getReceipt(rpcUrl, txHash, tries = 80, delayMs = 500) {
  for (let i = 0; i < tries; i += 1) {
    const res = await rpcPost(rpcUrl, "eth_getTransactionReceipt", [txHash]);
    if (res.ok && res.result) return res.result;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

function normalizeReceiptForStorage(receipt) {
  if (!receipt) return null;
  return {
    transactionHash: receipt.transactionHash,
    status: receipt.status,
    gasUsed: receipt.gasUsed || null,
    blockNumber: receipt.blockNumber || null,
    logs: Array.isArray(receipt.logs) ? receipt.logs.length : 0,
    contractAddress: receipt.contractAddress || null,
    from: receipt.from || null,
    to: receipt.to || null,
  };
}

function bigintCompare(a, b) {
  if (a === null || b === null) return null;
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}

function toDecimalWei(value) {
  return value === null ? null : value.toString();
}

function detectPositiveValueDelta(deltas) {
  const candidates = [
    deltas?.callerEthDelta,
    deltas?.receiverEthDelta,
    deltas?.callerTokenDelta,
    deltas?.receiverTokenDelta,
  ];
  return candidates.some((entry) => entry !== null && entry > 0n);
}

async function runTxAttempt(rpcUrl, target, fnSpec, accounts) {
  const sender = accounts[0];
  const receiver = accounts[1] || accounts[0];
  const targetAddress = normalizeAddress(target?.address || target);

  if (!targetAddress) {
    return {
      function: fnSpec.name,
      signature: fnSpec.signature,
      selector: fnSpec.selector,
      pre: null,
      post: null,
      deltas: null,
      attempt: {
        attempted: false,
        txHash: null,
        status: "blocked",
        reverted: true,
        gasEstimate: null,
        gasUsed: null,
        error: "invalid-target-address",
      },
      status: "blocked",
      success: false,
      valueDeltaPositive: false,
      post: null,
    };
  }

  if (!sender || !receiver || !isLocalRpc(rpcUrl)) {
    return {
      function: fnSpec.name,
      signature: fnSpec.signature,
      selector: fnSpec.selector,
      target: targetAddress || target,
      pre: null,
      post: null,
      attempt: {
        attempted: false,
        txHash: null,
        status: "blocked",
        reverted: true,
        gasEstimate: null,
        gasUsed: null,
        error: "local-rpc-required",
      },
      valueDeltaPositive: false,
    };
  }

  const context = { sender, receiver };
  const args = fnSpec.buildArgs(context);
  const data = buildData(fnSpec.selector, args, fnSpec.argTypes);

  const txObj = {
    from: sender,
    to: targetAddress,
    data,
    value: "0x0",
  };

  const tokenCtx = target?.tokenContext || null;
  const pre = {
    senderEth: null,
    receiverEth: null,
    senderToken: null,
    receiverToken: null,
  };

  pre.senderEth = await getBalance(rpcUrl, sender);
  pre.receiverEth = await getBalance(rpcUrl, receiver);
  if (tokenCtx && tokenCtx.token) {
    pre.senderToken = await readTokenBalance(rpcUrl, tokenCtx.token, sender);
    pre.receiverToken = await readTokenBalance(rpcUrl, tokenCtx.token, receiver);
  }

  const staticCall = await getEthCallResult(rpcUrl, targetAddress, data);
  const gasEstimate = await estimateGas(rpcUrl, txObj).catch(() => null);

  const snapshot = await snapshotState(rpcUrl);

  let attempt = {
    attempted: false,
    txHash: null,
    status: "not-sent",
    reverted: true,
    gasEstimate,
    gasUsed: null,
    staticCall: {
      ok: staticCall.ok,
      error: staticCall.ok ? null : staticCall.error,
      revert: staticCall.ok ? null : extractRevertFromPayload(staticCall.raw),
    },
    error: null,
    receipt: null,
    rawReceipt: null,
  };

  try {
    attempt.attempted = true;
    const sendRes = await rpcPost(rpcUrl, "eth_sendTransaction", [txObj]);
    if (!sendRes.ok) {
      attempt.error = sendRes.error || "eth_sendTransaction-failed";
      attempt.status = "not-sent";
      return {
        function: fnSpec.name,
        signature: fnSpec.signature,
        selector: fnSpec.selector,
        pre,
        post: pre,
        attempt,
        valueDeltaPositive: false,
      };
    }

    const txHash = sendRes.result;
    attempt.txHash = txHash;
    const receipt = await getReceipt(rpcUrl, txHash);
    attempt.rawReceipt = receipt;
    attempt.receipt = normalizeReceiptForStorage(receipt);

    if (receipt) {
      attempt.status = receipt.status === "0x1" ? "success" : "reverted";
      attempt.reverted = receipt.status !== "0x1";
      attempt.gasUsed = receipt.gasUsed || null;
    } else {
      attempt.status = "unknown-no-receipt";
      attempt.error = "timed-out waiting for tx receipt";
      attempt.reverted = true;
    }
  } catch (err) {
    attempt.error = sanitizeError(err);
    attempt.status = "exception";
    attempt.reverted = true;
  } finally {
    if (snapshot) {
      await revertState(rpcUrl, snapshot).catch(() => null);
    }
  }

  const post = {
    senderEth: await getBalance(rpcUrl, sender),
    receiverEth: await getBalance(rpcUrl, receiver),
    senderToken: tokenCtx?.token ? await readTokenBalance(rpcUrl, tokenCtx.token, sender) : null,
    receiverToken: tokenCtx?.token ? await readTokenBalance(rpcUrl, tokenCtx.token, receiver) : null,
  };

  const deltas = {
    callerEthDelta: pre.senderEth !== null && post.senderEth !== null ? post.senderEth - pre.senderEth : null,
    receiverEthDelta: pre.receiverEth !== null && post.receiverEth !== null ? post.receiverEth - pre.receiverEth : null,
    callerTokenDelta: pre.senderToken !== null && post.senderToken !== null ? post.senderToken - pre.senderToken : null,
    receiverTokenDelta: pre.receiverToken !== null && post.receiverToken !== null ? post.receiverToken - pre.receiverToken : null,
  };

  const valueDeltaPositive = detectPositiveValueDelta(deltas);

  return {
    function: fnSpec.name,
    signature: fnSpec.signature,
    selector: fnSpec.selector,
    pre,
    post,
    deltas: {
      callerEthDelta: toDecimalWei(deltas.callerEthDelta),
      receiverEthDelta: toDecimalWei(deltas.receiverEthDelta),
      callerTokenDelta: toDecimalWei(deltas.callerTokenDelta),
      receiverTokenDelta: toDecimalWei(deltas.receiverTokenDelta),
      token: tokenCtx?.token || null,
      tokenDecimals: tokenCtx?.tokenDecimals ? tokenCtx.tokenDecimals.toString() : null,
      tokenSymbol: tokenCtx?.tokenSymbol || null,
    },
    attempt: {
      ...attempt,
      gasEstimate: attempt.gasEstimate || null,
    },
    status: attempt.reverted ? "reverted" : "success",
    success: !attempt.reverted,
    valueDeltaPositive,
    post,
  };
}

function buildMarkdownReport(payload) {
  const lines = [];
  const header =
    payload.classification === "🟢 DORMANT"
      ? "# 🟢 DORMANT"
      : payload.classification === "⚠️ LOCAL-PROOF"
      ? "# ⚠️ LOCAL-PROOF"
      : "# BLOCKED";
  lines.push(`${header} — Stader Fork Transaction Test`);
  lines.push("");
  lines.push(`Generated: ${payload.generatedAt}`);
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(payload.blocked
    ? "Fork validation is blocked for this run due local setup gaps (no usable localhost Anvil fork path)."
    : "Local-only fork tx attempts completed for Stader targets. No public exploit assertions are made from any local revert/success alone.");
  lines.push("");
  lines.push("## Safety");
  lines.push(`- localForkTransactions: ${payload.safety.localForkTransactions}`);
  lines.push(`- liveTransactions: ${payload.safety.liveTransactions}`);
  lines.push(`- broadcasts: ${payload.safety.broadcasts}`);
  lines.push(`- privateKeysRead: ${payload.safety.privateKeysRead}`);
  lines.push(`- rpcUrlsStored: ${payload.safety.rpcUrlsStored}`);
  lines.push(`- rawUrlsStored: ${payload.safety.rawUrlsStored}`);
  lines.push(`- signedActions: ${payload.safety.signedActions}`);
  lines.push(`- anvilLocalhostOnly: ${payload.safety.anvilLocalhostOnly}`);
  lines.push("- transaction path: localhost JSON-RPC only");
  lines.push("");

  lines.push("## Metrics");
  lines.push(`- txAttempts: ${payload.metrics.txAttempts}`);
  lines.push(`- txSuccesses: ${payload.metrics.txSuccesses}`);
  lines.push(`- txReverts: ${payload.metrics.txReverts}`);
  lines.push(`- valueDeltaPositiveRows: ${payload.metrics.valueDeltaPositiveRows}`);
  lines.push(`- routePositive: ${payload.routePositive}`);
  lines.push(`- executableNow: ${payload.executableNow}`);
  lines.push(`- signedActionJustified: ${payload.signedActionJustified}`);
  lines.push(`- forkJustified: ${payload.forkJustified}`);
  lines.push(`- forkGate: ${payload.forkGate}`);
  lines.push(`- anvilAvailable: ${payload.anvilAvailable}`);
  lines.push("");

  lines.push("## Scope");
  lines.push(`- targets: ${payload.targets.length}`);
  for (const target of payload.targets) {
    lines.push(`- ${target.address} (${target.source})`);
  }
  lines.push("");

  if (payload.blockers && payload.blockers.length) {
    lines.push("## Blockers");
    for (const blocker of payload.blockers) lines.push(`- ${blocker}`);
    lines.push("");
  }

  lines.push("## Results");
  for (const target of payload.targetsResults) {
    lines.push(`### ${target.address}`);
    if (!target.attempts.length) {
      lines.push("- no tx attempts");
      continue;
    }
    for (const attempt of target.attempts) {
      const deltaText = attempt.deltas
        ? [
            `callerETH∆=${attempt.deltas.callerEthDelta || "n/a"}`,
            `receiverETH∆=${attempt.deltas.receiverEthDelta || "n/a"}`,
            `callerToken∆=${attempt.deltas.callerTokenDelta || "n/a"}`,
            `receiverToken∆=${attempt.deltas.receiverTokenDelta || "n/a"}`,
          ].join(", ")
        : "no deltas";
      const txHash = attempt.attempt?.txHash || "n/a";
      const gasUsed = attempt.attempt?.gasUsed || "n/a";
      const status = attempt.success ? "success" : "reverted/fail";
      lines.push(`- ${attempt.function} ${attempt.signature} — ${status} | tx=${txHash} | gasUsed=${gasUsed} | ${deltaText}`);
      if (attempt.attempt?.error) {
        lines.push(`  - error: ${attempt.attempt.error}`);
      }
    }
    lines.push("");
  }

  lines.push("## Next Step");
  lines.push(payload.classification === "🟢 DORMANT"
    ? "Treat as read-only until a positive on-chain delta proof exists with exact local-positive routing."
    : "Coordinate with route gate review before any live signed action.");

  return `${lines.join("\n")}\n`;
}

async function main() {
  const stader = readJson(IN_JSON);
  if (!stader) throw new Error("stader-full-test artifact missing or invalid");

  const summary = stader.summary || {};
  const routePositive = Number(summary.routePositive || stader.routePositive || 0);
  const executableNow = Number(summary.executableNow || stader.executableNow || 0);
  const forkGate = summary.forkGate || stader.forkGate || "closed-route-positive-zero";
  const signedActionJustified = Boolean(stader.signedActionJustified || false);

  const blockers = [];
  const targets = collectTargets(stader, stader.target?.sampleAddresses || []);

  if (!targets.length) {
    blockers.push("No code-present Ethereum Stader sample/probe rows found in stader-full-test source artifact.");
  }

  const forkSrc = await resolveEthereumForkEndpoint();
  if (!forkSrc) {
    blockers.push("No usable Ethereum fork URL was found from rpc_endpoints.txt and resolved to chainId=1.");
  }

  let anvilHandle = null;
  if (!blockers.length) {
    anvilHandle = await startAnvil(forkSrc);
    if (!anvilHandle?.ok) {
      blockers.push(anvilHandle.error || "Anvil could not be started");
    } else {
      const ready = await waitForFork(anvilHandle.providerUrl);
      if (!ready) blockers.push("Anvil fork failed to respond before timeout");
    }
  }

  const anvilAvailable = Boolean(anvilHandle && anvilHandle.ok);
  const payload = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/fork-test-stader-transactions.js",
    scope: "Stader Ethereum local Anvil tx attempts",
    sourceArtifact: "reports/raw/fast/stader-full-test.json",
    routePositive,
    executableNow,
    forkGate,
    signedActionJustified: false,
    sourceRoutePositives: {
      routePositive,
      executableNow,
      forkGate,
      forkJustified: false,
      signedActionJustified,
    },
    anvilAvailable,
    safety: {
      localForkTransactions: blockers.length === 0,
      liveTransactions: false,
      broadcasts: false,
      privateKeysRead: false,
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      rawUrlsStored: false,
      signedActions: false,
      liveSignedActions: false,
      anvilLocalhostOnly: true,
    },
    metrics: {
      txAttempts: 0,
      txSuccesses: 0,
      txReverts: 0,
      valueDeltaPositiveRows: 0,
      routePositive,
      executableNow,
      signedActionJustified: false,
      forkJustified: false,
      forkGate,
    },
    forkJustified: false,
    blockers: [],
    targets: targets.map((t) => ({
      address: t.address,
      source: t.source,
    })),
    targetsResults: [],
    classification: "🟢 DORMANT",
  };

  if (blockers.length) {
    payload.blockers = blockers;
    payload.blocked = true;
    payload.classification = "BLOCKED";
    payload.targets = targets
      .map((target) => ({ address: normalizeAddress(target.address), source: target.source }))
      .filter((entry) => entry.address)
      .map((entry) => entry);
    payload.targetsResults = targets.map((t) => ({ address: t.address, source: t.source, attempts: [] }));
    ensureDir(OUT_JSON);
    fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, jsonReplacer, 2)}\n`);
    fs.writeFileSync(OUT_MD, buildMarkdownReport(payload));
    if (anvilHandle) await stopAnvil(anvilHandle);
    return;
  }

  try {
    const accounts = await getAccounts(anvilHandle.providerUrl);
    if (!accounts.length || accounts.length < 2) {
      throw new Error("No usable local anvil accounts were returned by eth_accounts");
    }

    await Promise.all([
      rpcPost(anvilHandle.providerUrl, "anvil_setBalance", [accounts[0], toQuantity(200n * 10n ** 18n)]),
      rpcPost(anvilHandle.providerUrl, "anvil_setBalance", [accounts[1], toQuantity(200n * 10n ** 18n)]),
    ]);

    const targetsToProbe = targets.slice(0, 8);

    for (const target of targetsToProbe) {
      const targetAddress = normalizeAddress(target.address);
      if (!targetAddress) continue;

      const tokenContext = await readTokenContext(anvilHandle.providerUrl, targetAddress);
      const result = {
        address: targetAddress,
        source: target.source || "unknown",
        tokenContext,
        attempts: [],
      };

      for (const fnSpec of TARGET_FUNCS) {
        const row = await runTxAttempt(anvilHandle.providerUrl, { address: targetAddress, tokenContext }, fnSpec, accounts);
        result.attempts.push(row);

        payload.metrics.txAttempts += 1;
        if (row.success) payload.metrics.txSuccesses += 1;
        else payload.metrics.txReverts += 1;
        if (row.valueDeltaPositive) payload.metrics.valueDeltaPositiveRows += 1;
      }

      payload.targetsResults.push(result);
    }

    const hasPositiveEvidence = routePositive > 0 && payload.metrics.valueDeltaPositiveRows > 0;
    payload.forkJustified = hasPositiveEvidence;
    payload.metrics.forkJustified = hasPositiveEvidence;
    payload.metrics.signedActionJustified = false;
    payload.classification = hasPositiveEvidence ? "⚠️ LOCAL-PROOF" : "🟢 DORMANT";
    payload.forkGate = hasPositiveEvidence ? "open-route-positive-pending-gate" : forkGate;
    payload.blocked = false;
    payload.blockers = [];
  } catch (err) {
    payload.blocked = true;
    payload.classification = "BLOCKED";
    payload.blockers.push(sanitizeError(err) || "execution-failure");
    payload.targetsResults = payload.targetsResults.length ? payload.targetsResults : targets.map((t) => ({ address: t.address, source: t.source, attempts: [] }));
  } finally {
    if (anvilHandle) await stopAnvil(anvilHandle);
  }

  ensureDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, jsonReplacer, 2)}\n`);
  const md = buildMarkdownReport(payload);
  ensureDir(OUT_MD);
  fs.writeFileSync(OUT_MD, md);

  if (!QUIET) {
    console.log(`wrote: ${OUT_JSON_REL} and ${OUT_MD_REL}`);
    console.log(`forkAvailable=${payload.anvilAvailable}; txAttempts=${payload.metrics.txAttempts}; valueDeltaPositive=${payload.metrics.valueDeltaPositiveRows}`);
  }
}

main().catch((error) => {
  console.error(`fork-test-stader-transactions failed: ${sanitizeError(error) || "unknown"}`);
  process.exit(1);
});
