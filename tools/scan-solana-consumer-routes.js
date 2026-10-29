#!/usr/bin/env node
// Read-only Solana lending/perps consumer scanner for xStocks Token-2022 mints.
// Queries Helius RPC to check if any xStocks mint has token accounts
// owned by known Solana lending/perps protocol programs.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "solana-consumer-routes.json");
const QUIET = process.argv.includes("--quiet");

const XSTOCKS_LIVE = path.join(WORKSPACE, "reports", "raw", "fast", "xstocks-live.json");

const TIMEOUT_MS = 30_000;
const MAX_ACCOUNTS_PER_MINT = 30;

const SOLANA_PROTOCOL_PROGRAMS = {
  KLend2g3cP87fffoy8q1mQqGKjrxRVdPk6s7p3H3gZE: { name: "Kamino Lending", type: "lending" },
  So1endDq2YkqhipRh3WViPA8SdiFcWzZ1z3p5F1gzB: { name: "Solend", type: "lending" },
  MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA: { name: "Marginfi", type: "lending" },
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: { name: "Drift v2", type: "perps-lending" },
};

const KNOWN_PROTOCOL_PROGRAM_IDS = new Set(Object.keys(SOLANA_PROTOCOL_PROGRAMS).filter((k) => SOLANA_PROTOCOL_PROGRAMS[k]));

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

function solRpcCandidates() {
  const candidates = [];
  if (fs.existsSync(RPC_FILE)) {
    for (const line of fs.readFileSync(RPC_FILE, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
      if (/solana/i.test(line)) for (const match of line.matchAll(/https?:\/\/[^\s'"<>]+/g)) candidates.push(match[0]);
    }
  }
  candidates.push("https://api.mainnet-beta.solana.com");
  return [...new Set(candidates)];
}

async function solPostJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { "content-type": "application/json" };
  if (process.env.SOLANA_RPC_ORIGIN) headers.origin = process.env.SOLANA_RPC_ORIGIN;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function connectSolanaRpc() {
  let lastError;
  for (const url of solRpcCandidates()) {
    try {
      const version = await solPostJson(url, { jsonrpc: "2.0", id: 1, method: "getVersion", params: [] });
      const slot = await solPostJson(url, { jsonrpc: "2.0", id: 2, method: "getSlot", params: [{ commitment: "confirmed" }] });
      return { url, version, slot };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working Solana RPC candidate`);
}

function makeSolRpc(url) {
  let id = 10;
  return async function rpc(method, params = []) {
    return solPostJson(url, { jsonrpc: "2.0", id: id++, method, params });
  };
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let carry = BASE58_ALPHABET.indexOf(text[i]);
    if (carry < 0) return null;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < text.length && text[i] === "1"; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function base58Encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] * 256;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "";
  for (const digit of digits.reverse()) out += BASE58_ALPHABET[digit];
  for (const byte of bytes) {
    if (byte === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}

function parseAccountOwner(accountData) {
  if (!accountData || !Array.isArray(accountData.data)) return null;
  const buf = Buffer.from(accountData.data[0], "base64");
  if (buf.length < 64) return "unknown";
  const ownerBytes = buf.subarray(32, 64);
  if (ownerBytes.every((b) => b === 0)) return "zero-address";
  return base58Encode(ownerBytes);
}

async function main() {
  const xstocks = readJson(XSTOCKS_LIVE, {});
  const solanaTokens = Array.isArray(xstocks?.solana?.tokens) ? xstocks.solana.tokens : [];

  const mints = solanaTokens
    .map((t) => ({
      name: t?.name || t?.mintInfo?.token2022TokenMetadata?.parsed?.name || null,
      symbol: t?.mintInfo?.token2022TokenMetadata?.parsed?.symbol || null,
      mint: t?.mint || null,
      supply: asNumber(t?.mintInfo?.supply),
      decimals: asNumber(t?.mintInfo?.decimals),
      circulating: asNumber(t?.circulating),
      mintAuthority: t?.mintInfo?.mintAuthority || null,
      freezeAuthority: t?.mintInfo?.freezeAuthority || null,
      permanentDelegate: t?.mintInfo?.token2022ExtensionDetails?.PermanentDelegate?.delegate || null,
      pausableAuthority: t?.mintInfo?.token2022ExtensionDetails?.Pausable?.authority || null,
      paused: t?.mintInfo?.token2022ExtensionDetails?.Pausable?.paused ?? null,
      scaledUiMultiplier: asNumber(t?.mintInfo?.token2022ExtensionDetails?.ScaledUiAmountConfig?.multiplier),
      transferHookProgramId: t?.mintInfo?.token2022ExtensionDetails?.TransferHook?.programId || null,
      extensions: (t?.mintInfo?.token2022Extensions || []).map((e) => e.name),
    }))
    .filter((m) => m.mint);

  if (!mints.length) {
    console.log("No Solana mints found in xstocks-live.json");
    const artifact = buildArtifact({ mints: [], slot: null, version: null, discoveries: [], protocolMatches: [], watchCandidates: [] });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
    return;
  }

  let connection;
  try {
    connection = await connectSolanaRpc();
  } catch (err) {
    const artifact = buildArtifact({ mints, slot: null, version: null, discoveries: [], protocolMatches: [], watchCandidates: [], rpcError: String(err?.message || err) });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
    if (!QUIET) console.log(`Solana consumer: RPC connection failed`);
    return;
  }

  const rpc = makeSolRpc(connection.url);
  const discoveries = [];
  const protocolMatches = [];

  for (const mint of mints) {
    let largestAccounts;
    try {
      const result = await rpc("getTokenLargestAccounts", [mint.mint, { commitment: "confirmed" }]);
      largestAccounts = Array.isArray(result?.value) ? result.value : [];
    } catch (err) {
      discoveries.push({
        mint: mint.mint,
        symbol: mint.symbol,
        name: mint.name,
        step: "getTokenLargestAccounts",
        error: String(err?.message || err).slice(0, 200),
        accountsFound: 0,
        protocolOwners: [],
      });
      continue;
    }

    if (!largestAccounts.length) {
      discoveries.push({
        mint: mint.mint,
        symbol: mint.symbol,
        name: mint.name,
        step: "getTokenLargestAccounts",
        accountsFound: 0,
        protocolOwners: [],
      });
      continue;
    }

    const topN = largestAccounts.slice(0, MAX_ACCOUNTS_PER_MINT);
    const addresses = topN.map((a) => a.address).filter(Boolean);

    let accountInfos = new Map();
    if (addresses.length) {
      try {
        const batchSize = 50;
        for (let i = 0; i < addresses.length; i += batchSize) {
          const batch = addresses.slice(i, i + batchSize);
          const result = await rpc("getMultipleAccounts", [batch, { encoding: "base64", commitment: "confirmed" }]);
          if (Array.isArray(result?.value)) {
            result.value.forEach((info, idx) => {
              if (info) accountInfos.set(batch[idx], info);
            });
          }
        }
      } catch (err) {}
    }

    const protocolOwners = [];
    for (let i = 0; i < topN.length; i++) {
      const entry = topN[i];
      const acctInfo = accountInfos.get(entry.address);
      if (!acctInfo) continue;
      const owner = parseAccountOwner(acctInfo);
      if (!owner) continue;

      if (KNOWN_PROTOCOL_PROGRAM_IDS.has(owner)) {
        protocolOwners.push({
          tokenAccount: entry.address,
          owner,
          ownerProtocol: SOLANA_PROTOCOL_PROGRAMS[owner]?.name || owner,
          ownerType: SOLANA_PROTOCOL_PROGRAMS[owner]?.type || "unknown",
          amountRaw: entry.amount,
          amount: asNumber(entry.uiAmount) ?? (entry.amount ? (BigInt(entry.amount) / BigInt(10 ** (entry.decimals || 0))).toString() : null),
          decimals: entry.decimals || null,
          rank: i + 1,
        });
      }
    }

    discoveries.push({
      mint: mint.mint,
      symbol: mint.symbol,
      name: mint.name,
      step: "getMultipleAccounts",
      largestAccountsCount: largestAccounts.length,
      accountsFound: topN.length,
      accountsChecked: accountInfos.size,
      protocolOwners,
    });

    for (const po of protocolOwners) {
      protocolMatches.push({
        mint: mint.mint,
        symbol: mint.symbol,
        name: mint.name,
        supply: mint.supply,
        circulating: mint.circulating,
        scaledUiMultiplier: mint.scaledUiMultiplier,
        mintAuthority: mint.mintAuthority,
        freezeAuthority: mint.freezeAuthority,
        permanentDelegate: mint.permanentDelegate,
        pausableAuthority: mint.pausableAuthority,
        paused: mint.paused,
        ...po,
      });
    }
  }

  const watchCandidates = protocolMatches.filter((m) => asNumber(m.amount) > 0);

  const artifact = buildArtifact({
    mints,
    slot: connection.slot,
    version: connection.version,
    discoveries,
    protocolMatches,
    watchCandidates,
    rpcError: null,
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");

  if (!QUIET) {
    const matchedMints = [...new Set(protocolMatches.map((m) => m.mint))];
    console.log(`Solana consumer: mints=${mints.length} discoveries=${discoveries.filter((d) => d.accountsFound > 0).length} protocolOwners=${protocolMatches.length} uniqueMints=${matchedMints.length} watch=${watchCandidates.length}`);
  }
}

function buildArtifact({ mints, slot, version, discoveries, protocolMatches, watchCandidates, rpcError }) {
  const matchedMints = [...new Set(protocolMatches.map((m) => m.mint))];
  const routePositive = 0;

  return {
    generatedAt: new Date().toISOString(),
    scanner: "tools/scan-solana-consumer-routes.js",
    scope: "Read-only Solana lending/perps consumer discovery for xStocks Token-2022 mints",
    inputs: {
      xstocksLive: "reports/raw/fast/xstocks-live.json",
    },
    safety: {
      rpcInventoryRead: true,
      rpcUrlsStored: false,
      signedActions: false,
      exploitExecuteCalls: false,
      routePositive: routePositive > 0,
      signedActionJustified: false,
    },
    rpcStatus: rpcError ? { error: rpcError } : { connected: true, slot, version: version?.["solana-core"] || null },
    targets: {
      protocolPrograms: Object.fromEntries(Object.entries(SOLANA_PROTOCOL_PROGRAMS).filter(([, v]) => v)),
    },
    xstocksSolanaSummary: {
      mintsScanned: mints.length,
      generatedAt: null,
    },
    summary: {
      slot,
      mintsScanned: mints.length,
      mintsWithAccounts: discoveries.filter((d) => d.accountsFound > 0).length,
      totalAccountsChecked: discoveries.reduce((s, d) => s + d.accountsChecked, 0),
      protocolMatches: protocolMatches.length,
      matchedMints: matchedMints.length,
      watchCandidates: (watchCandidates || []).length,
      routePositive,
      signedActionJustified: false,
      closedReason: rpcError
        ? `Solana RPC connection failed: ${String(rpcError).slice(0, 100)}`
        : protocolMatches.length
          ? "xStocks mints found in Solana lending/perps but no exact route economics or fork proof"
          : "no xStocks mint token account is owned by any known Solana lending or perps protocol program",
    },
    discoveries: discoveries.slice(0, 200),
    protocolMatches: protocolMatches.slice(0, 100),
    watchCandidates: (watchCandidates || []).slice(0, 50),
    requiredForRoutePositive: [
      "xStocks Token-2022 mint is deposited in a Solana lending/perps protocol",
      "protocol allows borrowing/margin against the token",
      "xStocks-side signal (multiplier/pause/hook) is exploitable",
      "exact Solana swap/liquidation economics are positive after fees/gas",
      "fork extraction proof",
    ],
    nextReadOnlyStep: protocolMatches.length
      ? "Evaluate exact Solana protocol economics for matched mints; fork-proof only if a specific route is positive."
      : "Reopen only if xStocks or new Token-2022 mints appear as collateral/margin in Solana protocols, or extend to DEX pool ownership patterns.",
  };
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
