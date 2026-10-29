#!/usr/bin/env node
// Local Anvil fork proof for apyUSD buy-market -> receipt claim -> apxUSD.
// Starts a fork internally, performs only local fork transactions, and never prints RPC URLs.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ethers } = require("ethers");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const ROUTE_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-erc4626-redeem-route.json");
const OUT_FILE = path.join(WORKSPACE, "reports", "raw", "fast", "apyusd-erc4626-fork-proof.json");

const CHAIN_ID = 1;
const SHARE = "0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A";
const ASSET = "0x98A878b1Cd98131B271883B390f68D2c90674665";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const FUNDING_HOLDERS = [
  "0x7413522cA4B846Ff826E6d757af70a2Cb4083065", // Pancake apyUSD/apxUSD pool, not used for the Curve route.
  "0xe1b22a847e6a943bec9cdb38063192ece28036f6a8417f38714b08a444785bb8", // Uniswap pool hint from DexScreener.
  SHARE, // Last-resort local funding source; lowers vault cash on fork only.
];
const PORT = Number(process.env.APYUSD_FORK_PORT || "18657");
const TIMEOUT_MS = 15_000;
const CLAIM_DELAYS_DAYS = (process.env.APYUSD_CLAIM_DELAYS_DAYS || "3,4,7,20")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x) && x >= 0);

const ABI = ethers.AbiCoder.defaultAbiCoder();
const NONCE_STATE = new Map();
const ERC20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
]);
const CURVE = new ethers.Interface([
  "function exchange(int128 i,int128 j,uint256 dx,uint256 min_dy) returns (uint256)",
]);
const ERC4626 = new ethers.Interface([
  "event ReceiptIssued(address indexed owner,address indexed receiver,uint256 indexed tokenId,uint256 amount)",
  "function receipt() view returns (address)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function maxWithdraw(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function previewWithdraw(uint256 assets) view returns (uint256)",
  "function redeem(uint256 shares,address receiver,address owner) returns (uint256)",
  "function withdraw(uint256 assets,address receiver,address owner) returns (uint256)",
  "function redeemForReceipt(uint256 shares,address receiver,address owner) returns (uint256 assets,uint256 tokenId)",
  "function withdrawForReceipt(uint256 assets,address receiver,address owner) returns (uint256 shares,uint256 tokenId)",
]);
const UNLOCK_RECEIPT = new ethers.Interface([
  "function claim(uint256 tokenId,address receiver) returns (uint256 amount)",
  "function previewClaim(uint256 tokenId) view returns (uint256 amount)",
  "function currentFee(uint256 tokenId) view returns (uint256 feeInAssets)",
  "function claimableAfter(uint256 tokenId) view returns (uint48)",
  "function isClaimable(uint256 tokenId) view returns (bool)",
  "function getReceipt(uint256 tokenId) view returns (uint208 assets,uint208 feeInAssets,uint48 createdAt,uint48 claimableAt)",
]);
const KNOWN_ERROR_IFACE = new ethers.Interface([
  "error ERC4626ExceededMaxRedeem(address,uint256,uint256)",
  "error ERC4626ExceededMaxWithdraw(address,uint256,uint256)",
  "error ERC20InsufficientBalance(address,uint256,uint256)",
  "error ERC20InsufficientAllowance(address,uint256,uint256)",
  "error ERC20InvalidSender(address)",
  "error ERC20InvalidReceiver(address)",
  "error ERC721InvalidReceiver(address)",
  "error ERC721InvalidSender(address)",
  "error InvalidCaller()",
  "error NotClaimable(uint256)",
  "error Soulbound()",
  "error SafeERC20FailedOperation(address)",
  "error EnforcedPause()",
  "error ExpectedPause()",
  "error ReentrancyGuardReentrantCall()",
]);

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]").slice(0, 240);
}

function extractRevertData(value, depth = 0) {
  if (!value || depth > 5) return null;
  if (typeof value === "string" && /^0x[0-9a-fA-F]{8,}/.test(value)) return value;
  if (typeof value !== "object") return null;
  for (const key of ["data", "error", "info", "body", "response"]) {
    const found = extractRevertData(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function decodeRevertData(data) {
  if (!data || !/^0x[0-9a-fA-F]{8,}/.test(data)) return null;
  const selector = data.slice(0, 10).toLowerCase();
  if (selector === "0x08c379a0") {
    try {
      const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${data.slice(10)}`);
      return { selector, name: "Error", signature: "Error(string)", args: [sanitize(reason)] };
    } catch (_) {
      return { selector, name: "Error", signature: "Error(string)", args: [] };
    }
  }
  if (selector === "0x4e487b71") {
    try {
      const [code] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], `0x${data.slice(10)}`);
      return { selector, name: "Panic", signature: "Panic(uint256)", args: [code.toString()] };
    } catch (_) {
      return { selector, name: "Panic", signature: "Panic(uint256)", args: [] };
    }
  }
  try {
    const parsed = KNOWN_ERROR_IFACE.parseError(data);
    return { selector, name: parsed.name, signature: parsed.signature, args: parsed.args.map((arg) => typeof arg === "bigint" ? arg.toString() : String(arg)) };
  } catch (_) {
    return { selector, name: null, signature: null, args: [] };
  }
}

async function safeEthCall(provider, tx) {
  try {
    const raw = await provider.call(tx);
    return { ok: true, raw, error: null, revert: null };
  } catch (err) {
    const data = extractRevertData(err);
    return { ok: false, raw: null, error: sanitize(err?.shortMessage || err?.message || err), revert: decodeRevertData(data) };
  }
}

function loadRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  const text = fs.readFileSync(RPC_FILE, "utf8");
  return [...text.matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
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
    if (json.error) throw new Error(json.error.message || "rpc error");
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveRpcUrl(chainId) {
  for (const url of loadRpcUrls()) {
    try {
      const got = await rpcCall(url, "eth_chainId", [], 5000);
      if (Number(BigInt(got)) === chainId) return url;
    } catch (_) {
      // Try next endpoint; never print URLs.
    }
  }
  return null;
}

async function fetchPrice(address) {
  try {
    const addr = ethers.getAddress(address);
    const res = await fetch(`https://coins.llama.fi/prices/current/ethereum:${addr}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = await res.json();
    return Number(json?.coins?.[`ethereum:${addr}`]?.price) || null;
  } catch (_) {
    return null;
  }
}

function parseUnitsFromNumber(value, decimals) {
  return ethers.parseUnits(Number(value).toFixed(Math.min(decimals, 18)), decimals);
}

function formatUnits(raw, decimals) {
  return Number(ethers.formatUnits(raw, decimals));
}

function toBytes32(value) {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

function mappingSlot(address, slot) {
  return ethers.keccak256(ABI.encode(["address", "uint256"], [ethers.getAddress(address), BigInt(slot)]));
}

async function waitForFork(provider) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      await provider.send("eth_blockNumber", []);
      return;
    } catch (_) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Anvil fork did not become ready");
}

async function findBalanceSlot(provider, token, knownHolder) {
  const rawBalance = await provider.call({ to: token, data: ERC20.encodeFunctionData("balanceOf", [knownHolder]) });
  const balance = ERC20.decodeFunctionResult("balanceOf", rawBalance)[0];
  for (let slot = 0; slot < 200; slot++) {
    const key = mappingSlot(knownHolder, slot);
    const storage = await provider.getStorage(token, key);
    if (BigInt(storage || 0) === balance) return { slot, balance, key };
  }
  return { slot: null, balance, key: null };
}

async function balanceOf(provider, token, holder) {
  const raw = await provider.call({ to: token, data: ERC20.encodeFunctionData("balanceOf", [holder]) });
  return ERC20.decodeFunctionResult("balanceOf", raw)[0];
}

async function fundAttacker(provider, attacker, amountRaw, routePool) {
  const slotInfo = await findBalanceSlot(provider, ASSET, SHARE);
  if (slotInfo.slot !== null) {
    const attackerSlot = mappingSlot(attacker, slotInfo.slot);
    await provider.send("anvil_setStorageAt", [ASSET, attackerSlot, toBytes32(amountRaw)]);
    return { method: "storage-override", balanceStorageSlot: slotInfo.slot, balanceStorageHolder: SHARE, holderBalance: slotInfo.balance.toString() };
  }

  for (const rawHolder of FUNDING_HOLDERS) {
    const holder = ethers.getAddress(rawHolder);
    if (holder.toLowerCase() === routePool.toLowerCase()) continue;
    const holderBalance = await balanceOf(provider, ASSET, holder).catch(() => 0n);
    if (holderBalance < amountRaw) continue;
    await provider.send("anvil_setBalance", [holder, ethers.toBeHex(10n ** 21n)]);
    await provider.send("anvil_impersonateAccount", [holder]);
    try {
      const holderSigner = await provider.getSigner(holder);
      const receipt = await sendTx(holderSigner, ASSET, ERC20.encodeFunctionData("transfer", [attacker, amountRaw]));
      return { method: "impersonated-holder-transfer", holder, holderBalance: holderBalance.toString(), fundingTx: receipt.hash };
    } finally {
      await provider.send("anvil_stopImpersonatingAccount", [holder]).catch(() => null);
    }
  }

  return { method: null, error: "Could not locate storage slot or external apxUSD holder with sufficient balance" };
}

async function nextNonce(signer) {
  const from = await signer.getAddress();
  const key = from.toLowerCase();
  if (!NONCE_STATE.has(key)) {
    NONCE_STATE.set(key, await signer.provider.getTransactionCount(from, "latest"));
  }
  const nonce = NONCE_STATE.get(key);
  NONCE_STATE.set(key, nonce + 1);
  return { from, nonce };
}

function trackedNonce(address) {
  return NONCE_STATE.get(String(address).toLowerCase());
}

function setTrackedNonce(address, nonce) {
  NONCE_STATE.set(String(address).toLowerCase(), Number(nonce));
}

async function sendTx(signer, to, data) {
  const { nonce } = await nextNonce(signer);
  const tx = await signer.sendTransaction({ to, data, nonce });
  return tx.wait();
}

function parseReceiptIssued(txReceipt) {
  for (const log of txReceipt?.logs || []) {
    if (!log?.address || log.address.toLowerCase() !== SHARE.toLowerCase()) continue;
    try {
      const parsed = ERC4626.parseLog(log);
      if (parsed?.name !== "ReceiptIssued") continue;
      return {
        owner: parsed.args.owner,
        receiver: parsed.args.receiver,
        tokenId: parsed.args.tokenId,
        amount: parsed.args.amount,
      };
    } catch (_) {
      // Ignore unrelated logs from the same address.
    }
  }
  return null;
}

function decodeForReceiptResult(method, call) {
  if (!call?.ok || !call.raw) return null;
  try {
    const decoded = ERC4626.decodeFunctionResult(method, call.raw);
    return { amountOrShares: decoded[0], tokenId: decoded[1] };
  } catch (_) {
    return null;
  }
}

function gasStats(receipts, ethPriceUsd) {
  const gasUsed = receipts.filter(Boolean).reduce((sum, r) => sum + (r.gasUsed || 0n), 0n);
  const gasWei = receipts.filter(Boolean).reduce((sum, r) => sum + ((r.gasUsed || 0n) * (r.gasPrice || 0n)), 0n);
  const gasUsd = ethPriceUsd ? Number(ethers.formatEther(gasWei)) * ethPriceUsd : null;
  return { gasUsed, gasWei, gasUsd };
}

async function readReceiptState(provider, receiptAddress, tokenId, assetDecimals) {
  const stateCall = await safeEthCall(provider, {
    to: receiptAddress,
    data: UNLOCK_RECEIPT.encodeFunctionData("getReceipt", [tokenId]),
  });
  if (!stateCall.ok) return { ok: false, error: stateCall.error, revert: stateCall.revert };
  const [assets, feeInAssets, createdAt, claimableAt] = UNLOCK_RECEIPT.decodeFunctionResult("getReceipt", stateCall.raw);
  return {
    ok: true,
    assets,
    feeInAssets,
    createdAt,
    claimableAt,
    assetsFormatted: ethers.formatUnits(assets, assetDecimals),
    feeInAssetsFormatted: ethers.formatUnits(feeInAssets, assetDecimals),
  };
}

async function mineAt(provider, timestamp) {
  await provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
  await provider.send("evm_mine", []);
}

async function main() {
  if (!fs.existsSync(ROUTE_FILE)) throw new Error("Route artifact missing; run scan-apyusd-erc4626-redeem-route.js first");
  const route = JSON.parse(fs.readFileSync(ROUTE_FILE, "utf8"));
  const rows = route.rows || [];
  const best = rows.find((r) => r.routePositive) || rows.find((r) => r.quoteOk && Number(r.netUsd) > 0) || rows[0];
  if (!best?.quoteOk) throw new Error("No quoted apyUSD row available for fork diagnostic");
  const diagnosticOnly = !best.routePositive;

  const rpc = await resolveRpcUrl(CHAIN_ID);
  if (!rpc) throw new Error("No Ethereum RPC resolved from inventory");
  const forkBlock = route.chain?.blockNumber || undefined;
  const anvilArgs = ["--fork-url", rpc, "--port", String(PORT)];
  if (forkBlock) anvilArgs.push("--fork-block-number", String(forkBlock));
  const child = spawn("anvil", anvilArgs, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  const forkUrl = `http://127.0.0.1:${PORT}`;
  const provider = new ethers.JsonRpcProvider(forkUrl, CHAIN_ID);

  let out;
  try {
    await waitForFork(provider);
    const accounts = await provider.send("eth_accounts", []);
    const attackerWallet = ethers.Wallet.createRandom().connect(provider);
    const signer = attackerWallet;
    const attacker = await signer.getAddress();
    await provider.send("anvil_setBalance", [attacker, ethers.toBeHex(10n ** 20n)]);
    const attackerCode = await provider.getCode(attacker);
    if (attackerCode !== "0x") throw new Error("Generated attacker receiver is not a clean EOA");
    const assetDecimals = Number(route.candidate?.assetDecimals || 18);
    const shareDecimals = Number(route.candidate?.shareDecimals || 18);
    const amountInRaw = parseUnitsFromNumber(best.amountInAsset, assetDecimals);
    const pool = ethers.getAddress(best.pool);
    const inIndex = Number((route.pools || []).find((p) => p.pool?.toLowerCase() === pool.toLowerCase())?.inIndex ?? 1);
    const outIndex = Number((route.pools || []).find((p) => p.pool?.toLowerCase() === pool.toLowerCase())?.outIndex ?? 0);
    const receiptAddress = ethers.getAddress(ERC4626.decodeFunctionResult("receipt", await provider.call({ to: SHARE, data: ERC4626.encodeFunctionData("receipt", []) }))[0]);

    const funding = await fundAttacker(provider, attacker, amountInRaw, pool);
    if (!funding.method) throw new Error(funding.error || "Could not fund local fork attacker with apxUSD");

    const beforeAssetRaw = ERC20.decodeFunctionResult("balanceOf", await provider.call({ to: ASSET, data: ERC20.encodeFunctionData("balanceOf", [attacker]) }))[0];
    const approveReceipt = await sendTx(signer, ASSET, ERC20.encodeFunctionData("approve", [pool, amountInRaw]));
    const exchangeReceipt = await sendTx(signer, pool, CURVE.encodeFunctionData("exchange", [BigInt(inIndex), BigInt(outIndex), amountInRaw, 0n]));
    const sharesAfterRaw = ERC20.decodeFunctionResult("balanceOf", await provider.call({ to: SHARE, data: ERC20.encodeFunctionData("balanceOf", [attacker]) }))[0];
    const maxRedeemRaw = ERC4626.decodeFunctionResult("maxRedeem", await provider.call({ to: SHARE, data: ERC4626.encodeFunctionData("maxRedeem", [attacker]) }))[0];
    const maxWithdrawRaw = ERC4626.decodeFunctionResult("maxWithdraw", await provider.call({ to: SHARE, data: ERC4626.encodeFunctionData("maxWithdraw", [attacker]) }))[0];
    const previewRedeemRaw = sharesAfterRaw > 0n ? ERC4626.decodeFunctionResult("previewRedeem", await provider.call({ to: SHARE, data: ERC4626.encodeFunctionData("previewRedeem", [sharesAfterRaw]) }))[0] : 0n;
    const previewWithdrawSharesRaw = maxWithdrawRaw > 0n ? ERC4626.decodeFunctionResult("previewWithdraw", await provider.call({ to: SHARE, data: ERC4626.encodeFunctionData("previewWithdraw", [maxWithdrawRaw]) }))[0] : 0n;
    let redeemReceipt = null;
    let withdrawReceipt = null;
    let redeemFailure = null;
    let withdrawFailure = null;
    const redeemData = ERC4626.encodeFunctionData("redeemForReceipt", [sharesAfterRaw, attacker, attacker]);
    const redeemStatic = await safeEthCall(provider, { from: attacker, to: SHARE, data: redeemData });
    const redeemStaticReturn = decodeForReceiptResult("redeemForReceipt", redeemStatic);
    try {
      redeemReceipt = await sendTx(signer, SHARE, redeemData);
    } catch (err) {
      redeemFailure = { error: sanitize(err?.shortMessage || err?.message || err), revert: decodeRevertData(extractRevertData(err)) || redeemStatic.revert, staticCall: redeemStatic };
    }
    const withdrawData = !redeemReceipt && maxWithdrawRaw > 0n ? ERC4626.encodeFunctionData("withdrawForReceipt", [maxWithdrawRaw, attacker, attacker]) : null;
    const withdrawStatic = withdrawData
      ? await safeEthCall(provider, { from: attacker, to: SHARE, data: withdrawData })
      : { ok: false, error: redeemReceipt ? "redeemForReceipt succeeded; withdrawForReceipt not attempted" : "maxWithdraw is zero", revert: null };
    const withdrawStaticReturn = decodeForReceiptResult("withdrawForReceipt", withdrawStatic);
    if (!redeemReceipt && withdrawData) {
      try {
        withdrawReceipt = await sendTx(signer, SHARE, withdrawData);
      } catch (err) {
        withdrawFailure = { error: sanitize(err?.shortMessage || err?.message || err), revert: decodeRevertData(extractRevertData(err)) || withdrawStatic.revert, staticCall: withdrawStatic };
      }
    }
    const receiptMintTx = redeemReceipt || withdrawReceipt;
    const exitMethod = redeemReceipt ? "redeemForReceipt" : withdrawReceipt ? "withdrawForReceipt" : null;
    const issuedReceipt = receiptMintTx ? parseReceiptIssued(receiptMintTx) : null;
    const fallbackTokenId = issuedReceipt?.tokenId || redeemStaticReturn?.tokenId || withdrawStaticReturn?.tokenId || null;
    const receiptTokenId = fallbackTokenId !== null ? BigInt(fallbackTokenId) : null;
    const receiptState = receiptTokenId !== null ? await readReceiptState(provider, receiptAddress, receiptTokenId, assetDecimals) : null;
    const afterAssetBeforeClaimRaw = ERC20.decodeFunctionResult("balanceOf", await provider.call({ to: ASSET, data: ERC20.encodeFunctionData("balanceOf", [attacker]) }))[0];
    const afterShareRaw = ERC20.decodeFunctionResult("balanceOf", await provider.call({ to: SHARE, data: ERC20.encodeFunctionData("balanceOf", [attacker]) }))[0];

    const assetPriceUsd = route.candidate?.assetPriceUsd || await fetchPrice(ASSET) || 1;
    const ethPriceUsd = await fetchPrice(WETH) || route.gas?.ethPriceUsd || null;
    const baseReceipts = [approveReceipt, exchangeReceipt, receiptMintTx].filter(Boolean);
    const claimScenarios = [];
    if (receiptMintTx && receiptTokenId !== null && receiptState?.ok) {
      const claimBaseNonce = trackedNonce(attacker);
      let receiptSnapshot = await provider.send("evm_snapshot", []);
      for (const delayDays of CLAIM_DELAYS_DAYS) {
        if (claimScenarios.length > 0) {
          await provider.send("evm_revert", [receiptSnapshot]);
          receiptSnapshot = await provider.send("evm_snapshot", []);
        }
        if (claimBaseNonce !== undefined) setTrackedNonce(attacker, claimBaseNonce);
        const targetTimestamp = Number(receiptState.createdAt) + Math.round(delayDays * 86400);
        await mineAt(provider, targetTimestamp);
        const isClaimableCall = await safeEthCall(provider, { to: receiptAddress, data: UNLOCK_RECEIPT.encodeFunctionData("isClaimable", [receiptTokenId]) });
        const isClaimable = isClaimableCall.ok ? UNLOCK_RECEIPT.decodeFunctionResult("isClaimable", isClaimableCall.raw)[0] : false;
        const currentFeeCall = await safeEthCall(provider, { to: receiptAddress, data: UNLOCK_RECEIPT.encodeFunctionData("currentFee", [receiptTokenId]) });
        const currentFeeRaw = currentFeeCall.ok ? UNLOCK_RECEIPT.decodeFunctionResult("currentFee", currentFeeCall.raw)[0] : null;
        const previewClaimCall = await safeEthCall(provider, { to: receiptAddress, data: UNLOCK_RECEIPT.encodeFunctionData("previewClaim", [receiptTokenId]) });
        const previewClaimRaw = previewClaimCall.ok ? UNLOCK_RECEIPT.decodeFunctionResult("previewClaim", previewClaimCall.raw)[0] : null;
        const claimData = UNLOCK_RECEIPT.encodeFunctionData("claim", [receiptTokenId, attacker]);
        const claimStatic = await safeEthCall(provider, { from: attacker, to: receiptAddress, data: claimData });
        let claimReceipt = null;
        let claimFailure = null;
        if (claimStatic.ok) {
          try {
            claimReceipt = await sendTx(signer, receiptAddress, claimData);
          } catch (err) {
            claimFailure = { error: sanitize(err?.shortMessage || err?.message || err), revert: decodeRevertData(extractRevertData(err)) || claimStatic.revert };
          }
        } else {
          claimFailure = { error: claimStatic.error, revert: claimStatic.revert };
        }
        const afterAssetRaw = ERC20.decodeFunctionResult("balanceOf", await provider.call({ to: ASSET, data: ERC20.encodeFunctionData("balanceOf", [attacker]) }))[0];
        const profitRaw = afterAssetRaw - beforeAssetRaw;
        const stats = gasStats([...baseReceipts, claimReceipt].filter(Boolean), ethPriceUsd);
        const profitUsd = formatUnits(profitRaw, assetDecimals) * assetPriceUsd;
        const netProfitUsd = stats.gasUsd === null ? profitUsd : profitUsd - stats.gasUsd;
        claimScenarios.push({
          delayDays,
          targetTimestamp,
          isClaimable: Boolean(isClaimable),
          claimSuccess: Boolean(claimReceipt),
          currentFee: currentFeeRaw !== null ? ethers.formatUnits(currentFeeRaw, assetDecimals) : null,
          previewClaim: previewClaimRaw !== null ? ethers.formatUnits(previewClaimRaw, assetDecimals) : null,
          afterAsset: ethers.formatUnits(afterAssetRaw, assetDecimals),
          profitAsset: ethers.formatUnits(profitRaw, assetDecimals),
          profitUsd,
          gasUsed: stats.gasUsed.toString(),
          gasUsd: stats.gasUsd,
          netProfitUsd,
          claimError: claimFailure?.error || null,
          claimRevert: claimFailure?.revert || null,
          claimStaticCall: claimStatic,
          claimTx: claimReceipt?.hash || null,
        });
      }
    }

    const sortedSuccessfulClaims = claimScenarios.filter((x) => x.claimSuccess).sort((a, b) => (b.netProfitUsd ?? -Infinity) - (a.netProfitUsd ?? -Infinity));
    const sortedClaims = claimScenarios.slice().sort((a, b) => (b.netProfitUsd ?? -Infinity) - (a.netProfitUsd ?? -Infinity));
    const bestClaim = sortedSuccessfulClaims[0] || sortedClaims[0] || null;
    const forkProfitPositive = Boolean(bestClaim?.claimSuccess && bestClaim.netProfitUsd > 0);
    const redeemBlockers = [];
    if (!receiptMintTx) {
      redeemBlockers.push("redeemForReceipt and withdrawForReceipt failed on fork after acquiring shares");
      if (maxRedeemRaw === 0n) redeemBlockers.push("maxRedeem(attacker) is zero after Curve swap");
      else if (maxRedeemRaw < sharesAfterRaw) redeemBlockers.push("maxRedeem(attacker) is below acquired shares");
      else redeemBlockers.push("receipt minting exit reverts despite maxRedeem covering acquired shares");
    } else if (receiptTokenId === null) {
      redeemBlockers.push("receipt exit transaction succeeded but ReceiptIssued tokenId was not found");
    } else if (!receiptState?.ok) {
      redeemBlockers.push("receipt was minted but getReceipt failed");
    } else if (!bestClaim?.claimSuccess) {
      redeemBlockers.push("receipt was minted but claim failed for all tested delay scenarios");
    } else if (!forkProfitPositive) {
      redeemBlockers.push("receipt claim succeeds but net profit is not positive after fees and gas at tested delays");
    }

    out = {
      generatedAt: new Date().toISOString(),
      scanner: "tools/prove-apyusd-erc4626-redeem-fork.js",
      scope: "Local Anvil fork proof for apyUSD Curve buy, receipt mint, and delayed claim",
      safety: {
        rpcInventoryRead: true,
        rpcUrlsStored: false,
        liveSignedActions: false,
        localForkTransactions: true,
        exploitExecuteCalls: false,
      },
      fork: { rpc: "local-anvil", chainId: CHAIN_ID, forkBlock, port: PORT },
      routeSource: "reports/raw/fast/apyusd-erc4626-redeem-route.json",
      route: { pool, inIndex, outIndex, sizeUsd: best.sizeUsd, amountInAsset: best.amountInAsset, expectedNetUsd: best.netUsd, routePositiveSource: Boolean(best.routePositive), diagnosticOnly },
      setup: { ...funding, attacker, attackerCode, generatedCleanEoa: true },
      result: {
        success: Boolean(bestClaim?.claimSuccess),
        receiptMinted: Boolean(receiptMintTx),
        exitMethod,
        redeemError: redeemFailure?.error || null,
        redeemRevert: redeemFailure?.revert || redeemStatic.revert || null,
        redeemStaticCall: { ...redeemStatic, decodedReturn: redeemStaticReturn ? { amountOrShares: redeemStaticReturn.amountOrShares.toString(), tokenId: redeemStaticReturn.tokenId.toString() } : null },
        withdrawError: withdrawFailure?.error || null,
        withdrawRevert: withdrawFailure?.revert || withdrawStatic.revert || null,
        withdrawStaticCall: { ...withdrawStatic, decodedReturn: withdrawStaticReturn ? { amountOrShares: withdrawStaticReturn.amountOrShares.toString(), tokenId: withdrawStaticReturn.tokenId.toString() } : null },
        receiptAddress,
        receiptTokenId: receiptTokenId !== null ? receiptTokenId.toString() : null,
        receiptIssued: issuedReceipt ? { owner: issuedReceipt.owner, receiver: issuedReceipt.receiver, tokenId: issuedReceipt.tokenId.toString(), amount: ethers.formatUnits(issuedReceipt.amount, assetDecimals) } : null,
        receiptState: receiptState?.ok ? {
          assets: receiptState.assetsFormatted,
          feeInAssets: receiptState.feeInAssetsFormatted,
          createdAt: receiptState.createdAt.toString(),
          claimableAt: receiptState.claimableAt.toString(),
        } : receiptState,
        sharesReceived: ethers.formatUnits(sharesAfterRaw, shareDecimals),
        maxRedeem: ethers.formatUnits(maxRedeemRaw, shareDecimals),
        maxWithdraw: ethers.formatUnits(maxWithdrawRaw, assetDecimals),
        previewRedeem: ethers.formatUnits(previewRedeemRaw, assetDecimals),
        previewWithdrawShares: ethers.formatUnits(previewWithdrawSharesRaw, shareDecimals),
        afterShareBalance: ethers.formatUnits(afterShareRaw, shareDecimals),
        beforeAsset: ethers.formatUnits(beforeAssetRaw, assetDecimals),
        afterAssetBeforeClaim: ethers.formatUnits(afterAssetBeforeClaimRaw, assetDecimals),
        bestClaimDelayDays: bestClaim?.delayDays ?? null,
        claimScenarios,
        afterAsset: bestClaim?.afterAsset || ethers.formatUnits(afterAssetBeforeClaimRaw, assetDecimals),
        profitAsset: bestClaim?.profitAsset || ethers.formatUnits(afterAssetBeforeClaimRaw - beforeAssetRaw, assetDecimals),
        profitUsd: bestClaim?.profitUsd ?? (formatUnits(afterAssetBeforeClaimRaw - beforeAssetRaw, assetDecimals) * assetPriceUsd),
        gasUsed: bestClaim?.gasUsed || gasStats(baseReceipts, ethPriceUsd).gasUsed.toString(),
        gasUsd: bestClaim?.gasUsd ?? gasStats(baseReceipts, ethPriceUsd).gasUsd,
        netProfitUsd: bestClaim?.netProfitUsd ?? null,
        forkProfitPositive,
        blockers: redeemBlockers,
      },
      receipts: {
        funding: funding.fundingTx || null,
        approve: approveReceipt.hash,
        exchange: exchangeReceipt.hash,
        redeem: redeemReceipt?.hash || null,
        withdraw: withdrawReceipt?.hash || null,
        bestClaim: bestClaim?.claimTx || null,
      },
    };
  } catch (err) {
    out = {
      generatedAt: new Date().toISOString(),
      scanner: "tools/prove-apyusd-erc4626-redeem-fork.js",
      safety: { rpcInventoryRead: true, rpcUrlsStored: false, liveSignedActions: false, localForkTransactions: true, exploitExecuteCalls: false },
      routeSource: "reports/raw/fast/apyusd-erc4626-redeem-route.json",
      result: { success: false, error: sanitize(err?.message || err), forkProfitPositive: false },
    };
    throw err;
  } finally {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    if (out) fs.writeFileSync(OUT_FILE, JSON.stringify(out, jsonReplacer, 2));
    child.kill();
  }

  console.log(`apyUSD fork proof: success=${out.result.success} forkProfitPositive=${out.result.forkProfitPositive} netUsd=${out.result.netProfitUsd}`);
  console.log(`Artifact: ${path.relative(WORKSPACE, OUT_FILE)}`);
}

main().catch((err) => {
  console.error(`prove-apyusd-erc4626-redeem-fork failed: ${sanitize(err?.message || err)}`);
  process.exitCode = 1;
});
