#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "solstice-live.json");
const RPC_TIMEOUT_MS = 30_000;

const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const PDA_MARKER = Buffer.from("ProgramDerivedAddress");
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_P = (1n << 255n) - 19n;
const ED25519_D = mod(-121665n * modInv(121666n), ED25519_P);

const PROGRAMS = {
  usx: {
    label: "USX Program",
    programId: "USXyiSTsPEWz55pSK7sZoUL79ntoVGQbaTDT57tH6bx",
  },
  yieldVault: {
    label: "YieldVault Program",
    programId: "eUSXyKoZ6aGejYVbnp3wtWQ1E8zuokLAJPecPxxtgG3",
  },
};

const MINTS = {
  usx: {
    symbol: "USX",
    label: "USX mint",
    mint: "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG",
    docs: "https://docs.solstice.finance/solstice-for-builders/smart-contracts.md",
  },
  eusx: {
    symbol: "eUSX",
    label: "eUSX mint",
    mint: "3ThdFZQKM6kRyVGLG48kaPg5TRMhYMKY1iCRa9xop1WC",
    docs: "https://docs.solstice.finance/solstice-for-builders/smart-contracts.md",
  },
  slx: {
    symbol: "SLX",
    label: "SLX mint",
    mint: "SLXdx4BUt2v9uJQNzWqSfzTJ9UKLUDsvxHFMEEdrfgq",
    docs: "https://api.llama.fi/protocol/solstice",
  },
};

const TOKEN_2022_EXTENSION_NAMES = {
  0: "Uninitialized",
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  5: "ConfidentialTransferAccount",
  6: "DefaultAccountState",
  7: "ImmutableOwner",
  8: "MemoTransfer",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  11: "CpiGuard",
  12: "PermanentDelegate",
  13: "NonTransferableAccount",
  14: "TransferHook",
  15: "TransferHookAccount",
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "TokenGroup",
  22: "GroupMemberPointer",
  23: "TokenGroupMember",
  24: "ConfidentialMintBurn",
};

const PDA_SEEDS = [
  "state",
  "config",
  "global_state",
  "global-state",
  "authority",
  "vault_authority",
  "vault-authority",
  "mint_authority",
  "mint-authority",
  "token_authority",
  "token-authority",
  "admin",
  "treasury",
  "fee_vault",
  "fee-vault",
  "vault",
  "usx",
  "USX",
  "eusx",
  "eUSX",
  "yield_vault",
  "yield-vault",
  "collateral",
  "collateral_vault",
  "collateral-vault",
  "redemption",
  "redeem",
  "mint",
  "oracle",
  "price_oracle",
  "rate",
  "cooldown",
  "withdraw",
  "unlock",
  "staking",
];

const INTERESTING_STRING_RE = /anchor|solstice|usx|eusx|yield|vault|mint|redeem|redemption|collateral|authority|admin|oracle|price|rate|lock|unlock|withdraw|cooldown|pause|whitelist|kyc|custody|error|constraint|seed/i;

const ANCHOR_ACCOUNT_TYPES = [
  "Controller",
  "StableDepository",
  "PermissionedAccount",
  "ProgramAdmin",
  "Custodian",
  "UserMintEscrow",
  "UserRedeemEscrow",
  "AuthorityTransfer",
  "YieldPool",
  "VestingSchedule",
  "CooldownEscrow",
];

const ANCHOR_ACCOUNT_DISCRIMINATORS = Object.fromEntries(
  ANCHOR_ACCOUNT_TYPES.map((name) => [crypto.createHash("sha256").update(`account:${name}`).digest("hex").slice(0, 16), name]),
);

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]");
}

function mod(value, m = ED25519_P) {
  const result = value % m;
  return result >= 0n ? result : result + m;
}

function modPow(base, exponent, m = ED25519_P) {
  let result = 1n;
  let x = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * x, m);
    x = mod(x * x, m);
    e >>= 1n;
  }
  return result;
}

function modInv(value, m = ED25519_P) {
  return modPow(value, m - 2n, m);
}

function isQuadraticResidue(value) {
  const x = mod(value);
  return x === 0n || modPow(x, (ED25519_P - 1n) / 2n) === 1n;
}

function isOnEd25519CurveBytes(bytes) {
  if (bytes.length !== 32) return false;
  const copy = Buffer.from(bytes);
  copy[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) + BigInt(copy[i]);
  if (y >= ED25519_P) return false;
  const y2 = mod(y * y);
  const numerator = mod(y2 - 1n);
  const denominator = mod(ED25519_D * y2 + 1n);
  if (denominator === 0n) return false;
  return isQuadraticResidue(numerator * modInv(denominator));
}

function isOnCurve(pubkey) {
  try {
    return isOnEd25519CurveBytes(base58Decode(pubkey));
  } catch (_) {
    return null;
  }
}

function base58Decode(value) {
  let x = 0n;
  for (const char of value) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) throw new Error(`invalid base58 char: ${char}`);
    x = x * 58n + BigInt(digit);
  }
  const bytes = [];
  while (x > 0n) {
    bytes.push(Number(x & 0xffn));
    x >>= 8n;
  }
  for (const char of value) {
    if (char === "1") bytes.push(0);
    else break;
  }
  return Buffer.from(bytes.reverse());
}

function base58Encode(bytes) {
  let x = 0n;
  for (const byte of bytes) x = (x << 8n) + BigInt(byte);
  let out = "";
  while (x > 0n) {
    const digit = Number(x % 58n);
    out = BASE58_ALPHABET[digit] + out;
    x /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}

function findProgramAddress(seeds, programId) {
  const programBytes = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const payload = Buffer.concat([...seeds, Buffer.from([bump]), programBytes, PDA_MARKER]);
    const hash = crypto.createHash("sha256").update(payload).digest();
    if (!isOnEd25519CurveBytes(hash)) return { address: base58Encode(hash), bump };
  }
  throw new Error("Could not find PDA");
}

function createWithSeed(base, seed, owner) {
  const hash = crypto.createHash("sha256")
    .update(base58Decode(base))
    .update(Buffer.from(seed))
    .update(base58Decode(owner))
    .digest();
  return base58Encode(hash);
}

function associatedTokenAddress(owner, mint, tokenProgram) {
  return findProgramAddress([
    base58Decode(owner),
    base58Decode(tokenProgram),
    base58Decode(mint),
  ], ASSOCIATED_TOKEN_PROGRAM_ID);
}

function rpcCandidates() {
  const candidates = [];
  for (const key of ["SOLANA_RPC_URL", "SOLANA_RPC"]) {
    if (process.env[key]) candidates.push(process.env[key]);
  }

  if (fs.existsSync(RPC_FILE)) {
    const lines = fs.readFileSync(RPC_FILE, "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      if (/solana/i.test(line)) {
        for (const match of line.matchAll(/https?:\/\/[^\s'"<>]+/g)) candidates.push(match[0]);
      }
    }
  }

  candidates.push("https://api.mainnet-beta.solana.com");
  return [...new Set(candidates)];
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
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
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text.slice(0, 200))}`);
    const json = JSON.parse(text);
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function connectRpc() {
  let lastError;
  for (const url of rpcCandidates()) {
    try {
      const version = await postJson(url, { jsonrpc: "2.0", id: 1, method: "getVersion", params: [] });
      const slot = await postJson(url, { jsonrpc: "2.0", id: 2, method: "getSlot", params: [{ commitment: "confirmed" }] });
      const epochInfo = await postJson(url, { jsonrpc: "2.0", id: 3, method: "getEpochInfo", params: [{ commitment: "confirmed" }] });
      return { url, version, slot, epochInfo };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working Solana RPC candidate (${lastError ? sanitize(lastError.message || lastError) : "unknown error"})`);
}

function makeRpc(url) {
  let id = 10;
  return async function rpc(method, params = []) {
    return postJson(url, { jsonrpc: "2.0", id: id++, method, params });
  };
}

async function rpcMaybe(rpc, method, params = []) {
  try {
    return { ok: true, value: await rpc(method, params) };
  } catch (err) {
    return { ok: false, error: sanitize(err.message || err) };
  }
}

async function getMultipleAccounts(rpc, addresses, encoding = "base64") {
  const unique = [...new Set(addresses.filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    const result = await rpc("getMultipleAccounts", [batch, { encoding, commitment: "confirmed" }]);
    result.value.forEach((value, index) => out.set(batch[index], value));
  }
  return out;
}

function dataBuffer(account) {
  if (!account || !Array.isArray(account.data)) return null;
  return Buffer.from(account.data[0], "base64");
}

function accountSummary(account) {
  if (!account) return null;
  const data = dataBuffer(account);
  const first8Hex = data && data.length >= 8 ? data.subarray(0, 8).toString("hex") : null;
  return {
    exists: true,
    owner: account.owner,
    executable: account.executable,
    lamports: account.lamports,
    dataLength: data ? data.length : null,
    first8Hex,
    discriminatorName: ANCHOR_ACCOUNT_DISCRIMINATORS[first8Hex] || null,
  };
}

function tokenProgramKind(owner) {
  if (owner === TOKEN_PROGRAM_ID) return "spl-token";
  if (owner === TOKEN_2022_PROGRAM_ID) return "token-2022";
  return owner || "unknown";
}

function cOptionPubkey(data, offset) {
  if (!data || data.length < offset + 36) return null;
  const option = data.readUInt32LE(offset);
  if (option !== 1) return null;
  const bytes = data.subarray(offset + 4, offset + 36);
  if (bytes.every((byte) => byte === 0)) return null;
  return base58Encode(bytes);
}

function optionalPubkey(bytes) {
  if (!bytes || bytes.length !== 32 || bytes.every((byte) => byte === 0)) return null;
  return base58Encode(bytes);
}

function formatUnits(raw, decimals) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = value % scale;
  const fracText = frac.toString().padStart(decimals, "0").replace(/0+$/g, "").slice(0, 12);
  return fracText ? `${whole}.${fracText}` : whole.toString();
}

function parseToken2022Extensions(account) {
  const data = dataBuffer(account);
  if (!data) return [];
  const out = [];
  for (const start of [82, 83, 165, 166]) {
    let offset = start;
    const current = [];
    while (offset + 4 <= data.length) {
      const type = data.readUInt16LE(offset);
      const length = data.readUInt16LE(offset + 2);
      if (type === 0 && length === 0) break;
      if (length > data.length || offset + 4 + length > data.length) break;
      current.push({ type, name: TOKEN_2022_EXTENSION_NAMES[type] || `Unknown${type}`, length, offset });
      offset += 4 + length;
    }
    if (current.length > out.length) out.splice(0, out.length, ...current);
  }
  return out;
}

function parseToken2022TransferHook(account) {
  const data = dataBuffer(account);
  if (!data) return null;
  const transferHookExtension = parseToken2022Extensions(account).find((extension) => extension.type === 14 && extension.length >= 64);
  if (!transferHookExtension) return null;
  const start = transferHookExtension.offset + 4;
  return {
    authority: optionalPubkey(data.subarray(start, start + 32)),
    programId: optionalPubkey(data.subarray(start + 32, start + 64)),
  };
}

function parseToken2022TransferFee(account, epoch) {
  const data = dataBuffer(account);
  if (!data) return null;
  const transferFeeExtension = parseToken2022Extensions(account).find((extension) => extension.type === 1 && extension.length >= 108);
  if (!transferFeeExtension) return null;
  const start = transferFeeExtension.offset + 4;
  const older = {
    epoch: data.readBigUInt64LE(start + 72).toString(),
    maximumFee: data.readBigUInt64LE(start + 80).toString(),
    transferFeeBasisPoints: data.readUInt16LE(start + 88),
  };
  const newer = {
    epoch: data.readBigUInt64LE(start + 90).toString(),
    maximumFee: data.readBigUInt64LE(start + 98).toString(),
    transferFeeBasisPoints: data.readUInt16LE(start + 106),
  };
  const active = BigInt(epoch || 0) >= BigInt(newer.epoch) ? newer : older;
  return { older, newer, active };
}

function parseMintAccount(account, rpcSupply, epoch) {
  const data = dataBuffer(account);
  const out = {
    account: accountSummary(account),
    tokenProgramKind: tokenProgramKind(account && account.owner),
    mintAuthority: null,
    freezeAuthority: null,
    decimals: null,
    supplyRaw: null,
    supplyUi: null,
    rpcSupply: rpcSupply || null,
    token2022Extensions: [],
    token2022TransferFee: null,
    token2022TransferHook: null,
  };
  if (data && data.length >= 82) {
    out.mintAuthority = cOptionPubkey(data, 0);
    out.supplyRaw = data.readBigUInt64LE(36).toString();
    out.decimals = data.readUInt8(44);
    out.isInitialized = data.readUInt8(45) === 1;
    out.freezeAuthority = cOptionPubkey(data, 46);
    out.supplyUi = formatUnits(out.supplyRaw, out.decimals);
    out.token2022Extensions = parseToken2022Extensions(account);
    out.token2022TransferFee = parseToken2022TransferFee(account, epoch);
    out.token2022TransferHook = parseToken2022TransferHook(account);
  }
  return out;
}

function parseTokenAccount(account, decimals) {
  const data = dataBuffer(account);
  if (!data || data.length < 165) return null;
  const amountRaw = data.readBigUInt64LE(64).toString();
  const state = data.readUInt8(108);
  return {
    mint: base58Encode(data.subarray(0, 32)),
    ownerAuthority: base58Encode(data.subarray(32, 64)),
    ownerAuthorityOnCurve: isOnEd25519CurveBytes(data.subarray(32, 64)),
    amountRaw,
    amountUi: formatUnits(amountRaw, decimals),
    delegate: cOptionPubkey(data, 72),
    state: state === 1 ? "initialized" : state === 2 ? "frozen" : `state-${state}`,
    isNativeRaw: data.readUInt32LE(109) === 1 ? data.readBigUInt64LE(113).toString() : null,
    delegatedAmountRaw: data.readBigUInt64LE(121).toString(),
    closeAuthority: cOptionPubkey(data, 129),
    tokenProgramKind: tokenProgramKind(account.owner),
  };
}

function parseUpgradeableProgram(programAccount, programDataAccount) {
  const out = {
    account: accountSummary(programAccount),
    expectedOwner: BPF_LOADER_UPGRADEABLE,
    programDataAddress: null,
    programDataSlot: null,
    upgradeAuthority: null,
    elfOffset: null,
    elfSize: null,
    elfSha256: null,
    interestingStrings: [],
  };

  const programData = dataBuffer(programAccount);
  if (programData && programData.length >= 36 && programData.readUInt32LE(0) === 2) {
    out.programDataAddress = base58Encode(programData.subarray(4, 36));
  }

  const data = dataBuffer(programDataAccount);
  if (data) {
    if (data.length >= 48 && data.readUInt32LE(0) === 3) {
      out.programDataSlot = data.readBigUInt64LE(4).toString();
      const optionTag = data.readUInt32LE(12);
      out.upgradeAuthority = optionTag === 1 ? base58Encode(data.subarray(16, 48)) : null;
    }
    const elfOffset = data.indexOf(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    if (elfOffset >= 0) {
      const elf = data.subarray(elfOffset);
      out.elfOffset = elfOffset;
      out.elfSize = elf.length;
      out.elfSha256 = crypto.createHash("sha256").update(elf).digest("hex");
      out.interestingStrings = extractInterestingStrings(elf);
    }
  }

  return out;
}

function extractInterestingStrings(buffer) {
  const strings = [];
  let current = [];
  for (const byte of buffer) {
    if (byte >= 0x20 && byte <= 0x7e) {
      current.push(byte);
    } else {
      if (current.length >= 4) strings.push(Buffer.from(current).toString("utf8"));
      current = [];
    }
  }
  if (current.length >= 4) strings.push(Buffer.from(current).toString("utf8"));

  return [...new Set(strings.filter((value) => INTERESTING_STRING_RE.test(value)))].slice(0, 250);
}

function dataKnownRefs(account, knownPubkeys) {
  const data = dataBuffer(account);
  if (!data) return [];
  const refs = [];
  for (const [label, pubkey] of knownPubkeys) {
    const bytes = base58Decode(pubkey);
    if (data.indexOf(bytes) >= 0) refs.push({ label, pubkey });
  }
  return refs;
}

function summarizeProgramAccounts(accounts, knownPubkeys) {
  if (!accounts.ok) return { ok: false, error: accounts.error };
  const value = accounts.value || [];
  const lengthBuckets = new Map();
  const typeBuckets = new Map();
  const summaries = value.map((entry) => {
    const data = dataBuffer(entry.account);
    const length = data ? data.length : 0;
    const first8Hex = data ? data.subarray(0, 8).toString("hex") : null;
    const discriminatorName = ANCHOR_ACCOUNT_DISCRIMINATORS[first8Hex] || null;
    lengthBuckets.set(length, (lengthBuckets.get(length) || 0) + 1);
    typeBuckets.set(discriminatorName || first8Hex || "unknown", (typeBuckets.get(discriminatorName || first8Hex || "unknown") || 0) + 1);
    return {
      pubkey: entry.pubkey,
      lamports: entry.account.lamports,
      dataLength: length,
      first8Hex,
      discriminatorName,
      knownRefs: dataKnownRefs(entry.account, knownPubkeys),
    };
  }).sort((a, b) => b.lamports - a.lamports || b.dataLength - a.dataLength);

  return {
    ok: true,
    count: value.length,
    dataLengthBuckets: [...lengthBuckets.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([dataLength, count]) => ({ dataLength, count })),
    accountTypeBuckets: [...typeBuckets.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([type, count]) => ({ type, count })),
    topAccounts: summaries.slice(0, 50),
  };
}

function tryDecodeAnchorIdl(account) {
  const data = dataBuffer(account);
  if (!data) return null;
  for (const offset of [8, 40, 44]) {
    try {
      const inflated = zlib.inflateSync(data.subarray(offset));
      const parsed = JSON.parse(inflated.toString("utf8"));
      return {
        decoded: true,
        offset,
        name: parsed.name || parsed.metadata?.name || null,
        version: parsed.version || parsed.metadata?.version || null,
        instructionNames: (parsed.instructions || []).map((ix) => ix.name).slice(0, 100),
        accountNames: (parsed.accounts || []).map((acc) => acc.name).slice(0, 100),
        errorCount: Array.isArray(parsed.errors) ? parsed.errors.length : null,
      };
    } catch (_) {
      // Try the next common Anchor IDL account offset.
    }
  }
  return { decoded: false, dataLength: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex") };
}

async function scanMint(rpc, key, cfg, epoch) {
  const supply = await rpcMaybe(rpc, "getTokenSupply", [cfg.mint, { commitment: "confirmed" }]);
  const accountResult = await rpc("getAccountInfo", [cfg.mint, { encoding: "base64", commitment: "confirmed" }]);
  const mint = parseMintAccount(accountResult.value, supply.ok ? supply.value.value : null, epoch);
  const largest = await rpcMaybe(rpc, "getTokenLargestAccounts", [cfg.mint, { commitment: "confirmed" }]);
  const largestAddresses = largest.ok ? largest.value.value.map((entry) => entry.address) : [];
  const largestAccounts = largestAddresses.length ? await getMultipleAccounts(rpc, largestAddresses, "base64") : new Map();
  const largestParsed = largest.ok ? largest.value.value.map((entry) => {
    const parsed = parseTokenAccount(largestAccounts.get(entry.address), mint.decimals);
    return {
      tokenAccount: entry.address,
      amountRaw: entry.amount,
      amountUi: entry.uiAmountString,
      decimals: entry.decimals,
      account: parsed,
    };
  }) : [];

  const tokenProgram = accountResult.value ? accountResult.value.owner : null;
  const allAccounts = tokenProgram === TOKEN_PROGRAM_ID || tokenProgram === TOKEN_2022_PROGRAM_ID
    ? await scanTokenAccountsByMint(rpc, cfg.mint, tokenProgram, mint.decimals)
    : { ok: false, error: `mint owner is not an SPL token program: ${tokenProgram || "missing"}` };

  return {
    key,
    ...cfg,
    mint,
    largestAccounts: largest.ok ? { ok: true, value: largestParsed } : { ok: false, error: largest.error },
    allTokenAccounts: allAccounts,
  };
}

async function scanTokenAccountsByMint(rpc, mint, tokenProgram, decimals) {
  const filters = [{ memcmp: { offset: 0, bytes: mint } }];
  if (tokenProgram === TOKEN_PROGRAM_ID) filters.unshift({ dataSize: 165 });
  const result = await rpcMaybe(rpc, "getProgramAccounts", [tokenProgram, {
    encoding: "base64",
    commitment: "confirmed",
    filters,
  }]);
  if (!result.ok) return { ok: false, error: result.error };

  const entries = result.value.map((entry) => ({
    pubkey: entry.pubkey,
    account: parseTokenAccount(entry.account, decimals),
  })).filter((entry) => entry.account);

  const totalRaw = entries.reduce((acc, entry) => acc + BigInt(entry.account.amountRaw), 0n);
  const byAuthority = new Map();
  for (const entry of entries) {
    const owner = entry.account.ownerAuthority;
    const existing = byAuthority.get(owner) || { ownerAuthority: owner, ownerAuthorityOnCurve: entry.account.ownerAuthorityOnCurve, totalRaw: 0n, accountCount: 0, topAccounts: [] };
    existing.totalRaw += BigInt(entry.account.amountRaw);
    existing.accountCount += 1;
    existing.topAccounts.push({ tokenAccount: entry.pubkey, amountRaw: entry.account.amountRaw, amountUi: entry.account.amountUi, state: entry.account.state });
    byAuthority.set(owner, existing);
  }

  const owners = [...byAuthority.values()].map((entry) => ({
    ownerAuthority: entry.ownerAuthority,
    ownerAuthorityOnCurve: entry.ownerAuthorityOnCurve,
    totalRaw: entry.totalRaw.toString(),
    totalUi: formatUnits(entry.totalRaw.toString(), decimals),
    accountCount: entry.accountCount,
    topAccounts: entry.topAccounts.sort((a, b) => bigintCompareDesc(a.amountRaw, b.amountRaw)).slice(0, 10),
  })).sort((a, b) => bigintCompareDesc(a.totalRaw, b.totalRaw));

  return {
    ok: true,
    accountCount: entries.length,
    totalRaw: totalRaw.toString(),
    totalUi: formatUnits(totalRaw.toString(), decimals),
    topAccounts: entries.sort((a, b) => bigintCompareDesc(a.account.amountRaw, b.account.amountRaw)).slice(0, 25).map((entry) => ({
      tokenAccount: entry.pubkey,
      ...entry.account,
    })),
    topAuthorities: owners.slice(0, 50),
  };
}

function bigintCompareDesc(a, b) {
  const aa = BigInt(a);
  const bb = BigInt(b);
  return aa > bb ? -1 : aa < bb ? 1 : 0;
}

function buildPdaCandidates(programId) {
  const out = [];
  const add = (label, seeds) => {
    try {
      const pda = findProgramAddress(seeds, programId);
      out.push({ label, seeds: seeds.map(seedLabel), ...pda });
    } catch (err) {
      out.push({ label, error: err.message });
    }
  };

  for (const seed of PDA_SEEDS) add(seed, [Buffer.from(seed)]);

  for (const mintCfg of Object.values(MINTS)) {
    const mintBytes = base58Decode(mintCfg.mint);
    add(`${mintCfg.symbol}`, [mintBytes]);
    for (const seed of ["state", "config", "vault", "token_vault", "token-vault", "mint_authority", "mint-authority", "authority", "collateral_vault", "yield_vault", "rate", "cooldown"]) {
      add(`${seed}:${mintCfg.symbol}`, [Buffer.from(seed), mintBytes]);
      add(`${mintCfg.symbol}:${seed}`, [mintBytes, Buffer.from(seed)]);
    }
  }

  const dedup = new Map();
  for (const item of out) {
    if (!item.address || !dedup.has(item.address)) dedup.set(item.address || item.label, item);
  }
  return [...dedup.values()];
}

function seedLabel(seed) {
  const ascii = seed.toString("utf8");
  if (/^[\x20-\x7e]+$/.test(ascii)) return ascii;
  return base58Encode(seed);
}

async function scanProgram(rpc, key, cfg, knownPubkeys) {
  const programAccount = await rpc("getAccountInfo", [cfg.programId, { encoding: "base64", commitment: "confirmed" }]);
  if (!programAccount.value) throw new Error(`${cfg.label} not found`);

  let parsedProgram = parseUpgradeableProgram(programAccount.value, null);
  let programDataAccount = null;
  if (parsedProgram.programDataAddress) {
    const result = await rpc("getAccountInfo", [parsedProgram.programDataAddress, { encoding: "base64", commitment: "confirmed" }]);
    programDataAccount = result.value;
    parsedProgram = parseUpgradeableProgram(programAccount.value, programDataAccount);
  }

  const idlBase = findProgramAddress([], cfg.programId).address;
  const idlAddress = createWithSeed(idlBase, "anchor:idl", cfg.programId);
  const idlAccount = await rpcMaybe(rpc, "getAccountInfo", [idlAddress, { encoding: "base64", commitment: "confirmed" }]);

  const pdaCandidates = buildPdaCandidates(cfg.programId);
  const pdaAccounts = await getMultipleAccounts(rpc, pdaCandidates.map((entry) => entry.address), "base64");
  const existingPdas = pdaCandidates.map((entry) => ({
    ...entry,
    account: accountSummary(pdaAccounts.get(entry.address)),
  })).filter((entry) => entry.account);

  const programAccounts = await rpcMaybe(rpc, "getProgramAccounts", [cfg.programId, { encoding: "base64", commitment: "confirmed" }]);

  return {
    key,
    ...cfg,
    program: parsedProgram,
    anchorIdl: {
      idlAddress,
      account: idlAccount.ok ? accountSummary(idlAccount.value.value) : null,
      decode: idlAccount.ok && idlAccount.value.value ? tryDecodeAnchorIdl(idlAccount.value.value) : null,
      error: idlAccount.ok ? null : idlAccount.error,
    },
    existingPdas,
    programAccounts: summarizeProgramAccounts(programAccounts, knownPubkeys),
  };
}

async function scanAssociatedTokenAccounts(rpc, owners, mintsByKey) {
  const candidates = [];
  const add = (ownerLabel, owner, mintKey, mintCfg, tokenProgram) => {
    try {
      const pda = associatedTokenAddress(owner, mintCfg.mint, tokenProgram);
      candidates.push({ ownerLabel, owner, mintKey, mint: mintCfg.mint, symbol: mintCfg.symbol, tokenProgram, ata: pda.address, bump: pda.bump });
    } catch (_) {
      // Invalid public keys are ignored; all configured values should be valid.
    }
  };

  for (const owner of owners) {
    for (const [mintKey, mintCfg] of Object.entries(mintsByKey)) {
      add(owner.label, owner.pubkey, mintKey, mintCfg, mintCfg.tokenProgram || TOKEN_PROGRAM_ID);
      if (mintCfg.tokenProgram !== TOKEN_2022_PROGRAM_ID) add(owner.label, owner.pubkey, mintKey, mintCfg, TOKEN_2022_PROGRAM_ID);
    }
  }

  const dedup = new Map();
  for (const item of candidates) dedup.set(`${item.owner}:${item.mint}:${item.tokenProgram}`, item);
  const unique = [...dedup.values()];
  const accounts = await getMultipleAccounts(rpc, unique.map((item) => item.ata), "base64");
  return unique.map((item) => ({
    ...item,
    account: parseTokenAccount(accounts.get(item.ata), mintsByKey[item.mintKey]?.decimals ?? null),
    accountSummary: accountSummary(accounts.get(item.ata)),
  })).filter((item) => item.accountSummary);
}

function topAuthorityOwners(scannedMints) {
  const owners = new Map();
  for (const mint of Object.values(scannedMints)) {
    for (const entry of mint.largestAccounts?.value || []) {
      if (entry.account?.ownerAuthority) owners.set(entry.account.ownerAuthority, { label: `largest-${mint.symbol}`, pubkey: entry.account.ownerAuthority });
    }
    for (const entry of mint.allTokenAccounts?.topAuthorities || []) {
      owners.set(entry.ownerAuthority, { label: `top-authority-${mint.symbol}`, pubkey: entry.ownerAuthority });
    }
    if (mint.mint.mintAuthority) owners.set(mint.mint.mintAuthority, { label: `mint-authority-${mint.symbol}`, pubkey: mint.mint.mintAuthority });
    if (mint.mint.freezeAuthority) owners.set(mint.mint.freezeAuthority, { label: `freeze-authority-${mint.symbol}`, pubkey: mint.mint.freezeAuthority });
  }
  for (const program of Object.values(PROGRAMS)) owners.set(program.programId, { label: program.label, pubkey: program.programId });
  return [...owners.values()].slice(0, 250);
}

async function addOwnerAccountSummaries(rpc, scannedMints) {
  const ownerList = topAuthorityOwners(scannedMints);
  const accounts = await getMultipleAccounts(rpc, ownerList.map((entry) => entry.pubkey), "base64");
  return ownerList.map((entry) => ({
    ...entry,
    onCurve: isOnCurve(entry.pubkey),
    account: accountSummary(accounts.get(entry.pubkey)),
  }));
}

function buildKnownPubkeys(scannedMints) {
  const out = [];
  for (const [key, cfg] of Object.entries(PROGRAMS)) out.push([`${key}-program`, cfg.programId]);
  for (const [key, cfg] of Object.entries(MINTS)) out.push([`${key}-mint`, cfg.mint]);
  for (const mint of Object.values(scannedMints)) {
    for (const entry of mint.largestAccounts?.value || []) out.push([`${mint.symbol}-largest-token-account`, entry.tokenAccount]);
    for (const entry of mint.allTokenAccounts?.topAuthorities || []) out.push([`${mint.symbol}-top-authority`, entry.ownerAuthority]);
  }
  const dedup = new Map();
  for (const [label, pubkey] of out) dedup.set(`${label}:${pubkey}`, [label, pubkey]);
  return [...dedup.values()];
}

async function fetchDefiLlama() {
  const out = {};
  for (const slug of ["solstice", "solstice-usx"]) {
    try {
      const data = await fetchJson(`https://api.llama.fi/protocol/${slug}`);
      out[slug] = {
        name: data.name,
        category: data.category,
        symbol: data.symbol,
        address: data.address,
        audits: data.audits,
        currentChainTvls: data.currentChainTvls,
        tvlLast: Array.isArray(data.tvl) && data.tvl.length ? data.tvl[data.tvl.length - 1] : null,
        chainTvls: data.chainTvls ? Object.keys(data.chainTvls) : [],
      };
    } catch (err) {
      out[slug] = { error: sanitize(err.message || err) };
    }
  }
  return out;
}

function evaluate(scannedMints, scannedPrograms) {
  const risks = [];
  for (const mint of Object.values(scannedMints)) {
    risks.push({
      item: `${mint.symbol} mint authority`,
      status: mint.mint.mintAuthority ? "controlled" : "none",
      evidence: mint.mint.mintAuthority || "mint authority revoked",
    });
    risks.push({
      item: `${mint.symbol} freeze authority`,
      status: mint.mint.freezeAuthority ? "present" : "none",
      evidence: mint.mint.freezeAuthority || "freeze authority absent",
    });
    const activeFee = mint.mint.token2022TransferFee?.active?.transferFeeBasisPoints;
    if (activeFee !== undefined) {
      risks.push({ item: `${mint.symbol} Token-2022 transfer fee`, status: activeFee === 0 ? "inactive" : "active", evidence: `${activeFee} bps` });
    }
    if (mint.mint.token2022TransferHook) {
      risks.push({ item: `${mint.symbol} Token-2022 transfer hook`, status: mint.mint.token2022TransferHook.programId ? "active" : "none", evidence: mint.mint.token2022TransferHook.programId || "no hook program" });
    }
  }

  for (const program of Object.values(scannedPrograms)) {
    risks.push({
      item: `${program.label} upgrade authority`,
      status: program.program.upgradeAuthority ? "present" : "none",
      evidence: program.program.upgradeAuthority || "immutable program data",
    });
    risks.push({
      item: `${program.label} Anchor IDL`,
      status: program.anchorIdl.account ? "present" : "not found",
      evidence: program.anchorIdl.decode?.decoded ? `${program.anchorIdl.decode.instructionNames.length} decoded instructions` : (program.anchorIdl.decode?.sha256 || program.anchorIdl.error || "no IDL account"),
    });
  }

  const usx = scannedMints.usx;
  const eusx = scannedMints.eusx;
  const usxTop = usx?.allTokenAccounts?.topAuthorities?.[0];
  const eusxSupply = eusx?.mint?.supplyUi;
  if (usxTop && eusxSupply) {
    risks.push({
      item: "YieldVault backing discovery",
      status: "observed-top-holder",
      evidence: `largest USX authority holds ${usxTop.totalUi} USX; eUSX supply ${eusxSupply}`,
    });
  }

  return risks;
}

async function main() {
  if (!fs.existsSync(path.dirname(OUT))) fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const connection = await connectRpc();
  const rpc = makeRpc(connection.url);

  const scannedMints = {};
  for (const [key, cfg] of Object.entries(MINTS)) scannedMints[key] = await scanMint(rpc, key, cfg, connection.epochInfo && connection.epochInfo.epoch);

  const ownerSummaries = await addOwnerAccountSummaries(rpc, scannedMints);
  for (const mint of Object.values(scannedMints)) {
    const byOwner = new Map(ownerSummaries.map((entry) => [entry.pubkey, entry]));
    for (const entry of mint.largestAccounts?.value || []) {
      if (entry.account?.ownerAuthority) entry.ownerAuthorityAccount = byOwner.get(entry.account.ownerAuthority) || null;
    }
    for (const entry of mint.allTokenAccounts?.topAuthorities || []) {
      entry.ownerAuthorityAccount = byOwner.get(entry.ownerAuthority) || null;
    }
  }

  const knownPubkeys = buildKnownPubkeys(scannedMints);
  const scannedPrograms = {};
  for (const [key, cfg] of Object.entries(PROGRAMS)) scannedPrograms[key] = await scanProgram(rpc, key, cfg, knownPubkeys);

  const ataOwners = [
    ...Object.values(PROGRAMS).map((entry) => ({ label: entry.label, pubkey: entry.programId })),
    ...Object.values(scannedPrograms).flatMap((program) => program.existingPdas.map((pda) => ({ label: `${program.key}:${pda.label}`, pubkey: pda.address }))),
    ...ownerSummaries.filter((entry) => entry.onCurve === false).slice(0, 50).map((entry) => ({ label: entry.label, pubkey: entry.pubkey })),
  ];
  const mintsWithPrograms = Object.fromEntries(Object.entries(scannedMints).map(([key, value]) => [key, { ...MINTS[key], decimals: value.mint.decimals, tokenProgram: value.mint.account?.owner }]));
  const associatedTokenAccounts = await scanAssociatedTokenAccounts(rpc, ataOwners, mintsWithPrograms);

  const out = {
    generatedAt: new Date().toISOString(),
    chain: "solana-mainnet-beta",
    rpcSlot: connection.slot,
    rpcEpoch: connection.epochInfo && connection.epochInfo.epoch,
    rpcVersion: connection.version,
    target: {
      name: "Solstice",
      docs: [
        "https://docs.solstice.finance/solstice-for-builders/smart-contracts.md",
        "https://docs.solstice.finance/solstice-for-users/usx.md",
        "https://docs.solstice.finance/solstice-for-users/eusx-powered-by-yieldvault.md",
        "https://docs.solstice.finance/legal-documents/attestations-and-proof-of-solvency.md",
      ],
      safety: "read-only RPC and public API calls only; no signed actions",
    },
    defillama: await fetchDefiLlama(),
    mints: scannedMints,
    ownerSummaries,
    programs: scannedPrograms,
    associatedTokenAccounts,
    riskResolution: evaluate(scannedMints, scannedPrograms),
  };

  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);

  const mintSummary = Object.values(scannedMints).map((mint) => `${mint.symbol}=${mint.mint.supplyUi || "?"}`).join(" ");
  const programSummary = Object.values(scannedPrograms).map((program) => `${program.key}:upgrade=${program.program.upgradeAuthority ? "present" : "none"}`).join(" ");
  console.log(`Wrote ${OUT}`);
  console.log(`slot=${connection.slot} ${mintSummary}`);
  console.log(programSummary);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message || err));
  process.exit(1);
});
