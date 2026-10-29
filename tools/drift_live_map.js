#!/usr/bin/env node
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'targets', 'drift-protocol-v2');
const OUT_FILE = path.join(ROOT, 'reports', 'raw', 'drift-live-map.json');

const DRIFT_PROGRAM_ID = 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH';
const BPF_LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const PDA_MARKER = Buffer.from('ProgramDerivedAddress');
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_P = (1n << 255n) - 19n;
const ED25519_D = mod(-121665n * modInv(121666n), ED25519_P);
const TOKEN_2022_EXTENSION_NAMES = {
  0: 'Uninitialized',
  1: 'TransferFeeConfig',
  2: 'TransferFeeAmount',
  3: 'MintCloseAuthority',
  4: 'ConfidentialTransferMint',
  5: 'ConfidentialTransferAccount',
  6: 'DefaultAccountState',
  7: 'ImmutableOwner',
  8: 'MemoTransfer',
  9: 'NonTransferable',
  10: 'InterestBearingConfig',
  11: 'CpiGuard',
  12: 'PermanentDelegate',
  13: 'NonTransferableAccount',
  14: 'TransferHook',
  15: 'TransferHookAccount',
  16: 'ConfidentialTransferFeeConfig',
  17: 'ConfidentialTransferFeeAmount',
  18: 'MetadataPointer',
  19: 'TokenMetadata',
  20: 'GroupPointer',
  21: 'TokenGroup',
  22: 'GroupMemberPointer',
  23: 'TokenGroupMember',
  24: 'ConfidentialMintBurn',
};

function sanitize(text) {
  return String(text || '').replace(/https?:\/\/\S+/g, '[redacted-url]');
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

function isOnEd25519Curve(bytes) {
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
    if (char === '1') bytes.push(0);
    else break;
  }
  return Buffer.from(bytes.reverse());
}

function base58Encode(bytes) {
  let x = 0n;
  for (const byte of bytes) x = (x << 8n) + BigInt(byte);
  let out = '';
  while (x > 0n) {
    const digit = Number(x % 58n);
    out = BASE58_ALPHABET[digit] + out;
    x /= 58n;
  }
  for (const byte of bytes) {
    if (byte === 0) out = '1' + out;
    else break;
  }
  return out || '1';
}

function findProgramAddress(seeds, programId) {
  const programBytes = base58Decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const payload = Buffer.concat([...seeds, Buffer.from([bump]), programBytes, PDA_MARKER]);
    const hash = crypto.createHash('sha256').update(payload).digest();
    if (!isOnEd25519Curve(hash)) return { address: base58Encode(hash), bump };
  }
  throw new Error('Could not find PDA');
}

function u16le(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value, 0);
  return out;
}

function rpcCandidates() {
  const candidates = [];
  for (const key of ['SOLANA_RPC_URL', 'SOLANA_RPC']) {
    if (process.env[key]) candidates.push(process.env[key]);
  }

  const rpcFile = path.join(ROOT, 'rpc_endpoints.txt');
  if (fs.existsSync(rpcFile)) {
    const lines = fs.readFileSync(rpcFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (const line of lines) {
      if (/solana/i.test(line) && /^https?:\/\//i.test(line)) candidates.push(line);
    }
  }

  candidates.push('https://api.mainnet-beta.solana.com');
  return [...new Set(candidates)];
}

async function postJson(url, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

async function connectRpc() {
  let lastError;
  for (const url of rpcCandidates()) {
    try {
      const version = await postJson(url, { jsonrpc: '2.0', id: 1, method: 'getVersion', params: [] });
      const slot = await postJson(url, { jsonrpc: '2.0', id: 2, method: 'getSlot', params: [{ commitment: 'confirmed' }] });
      const epochInfo = await postJson(url, { jsonrpc: '2.0', id: 3, method: 'getEpochInfo', params: [{ commitment: 'confirmed' }] });
      return { url, version, slot, epochInfo };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`No working Solana RPC candidate (${lastError ? sanitize(lastError.message || lastError) : 'unknown error'})`);
}

function makeRpc(url) {
  let id = 10;
  return async function rpc(method, params = []) {
    return postJson(url, { jsonrpc: '2.0', id: id++, method, params });
  };
}

async function getMultipleAccounts(rpc, addresses) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 100) {
    const batch = addresses.slice(i, i + 100);
    const result = await rpc('getMultipleAccounts', [batch, { encoding: 'base64', commitment: 'confirmed' }]);
    result.value.forEach((value, index) => out.set(batch[index], value));
  }
  return out;
}

function parseUpgradeableProgram(programAccount, programDataAccount) {
  const out = {
    executable: programAccount.executable,
    owner: programAccount.owner,
    lamports: programAccount.lamports,
    programDataAddress: null,
    programDataSlot: null,
    upgradeAuthority: null,
    elfOffset: null,
    elfSize: null,
    elfSha256: null,
  };

  const programData = Buffer.from(programAccount.data[0], 'base64');
  if (programData.length >= 36 && programData.readUInt32LE(0) === 2) {
    out.programDataAddress = base58Encode(programData.subarray(4, 36));
  }

  if (programDataAccount) {
    const data = Buffer.from(programDataAccount.data[0], 'base64');
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
      out.elfSha256 = crypto.createHash('sha256').update(elf).digest('hex');
    }
  }

  return out;
}

function extractArraySource(text, name) {
  const start = text.indexOf(`export const ${name}`);
  if (start < 0) return '';
  const equals = text.indexOf('=', start);
  const arrayStart = text.indexOf('[', equals);
  let depth = 0;
  let quote = null;
  for (let i = arrayStart; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (depth === 0) return text.slice(arrayStart + 1, i);
  }
  return '';
}

function extractObjects(arraySource) {
  const objects = [];
  let start = -1;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < arraySource.length; i++) {
    const ch = arraySource[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) objects.push(arraySource.slice(start, i + 1));
    }
  }
  return objects;
}

function parsePublicKeyConstants(text) {
  const out = new Map();
  const re = /export const ([A-Za-z0-9_]+)[\s\S]*?new PublicKey\(\s*'([^']+)'\s*\)/g;
  let match;
  while ((match = re.exec(text))) out.set(match[1], match[2]);
  return out;
}

function parseMarketConfig(filePath, arrayName) {
  const text = fs.readFileSync(filePath, 'utf8');
  const constants = parsePublicKeyConstants(text);
  const arraySource = extractArraySource(text, arrayName);
  return extractObjects(arraySource).map((objectSource) => {
    const symbol = (objectSource.match(/symbol:\s*'([^']+)'/) || [])[1] || null;
    const marketIndex = Number((objectSource.match(/marketIndex:\s*(\d+)/) || [])[1]);
    const poolIdMatch = objectSource.match(/poolId:\s*(\d+)/);
    const oracle = (objectSource.match(/oracle:\s*new PublicKey\('([^']+)'\)/) || [])[1] || null;
    const oracleSource = (objectSource.match(/oracleSource:\s*OracleSource\.([A-Za-z0-9_]+)/) || [])[1] || null;
    let mint = (objectSource.match(/mint:\s*new PublicKey\('([^']+)'\)/) || [])[1] || null;
    if (!mint) {
      const mintConstant = (objectSource.match(/mint:\s*new PublicKey\(([A-Za-z0-9_]+)\)/) || [])[1];
      if (mintConstant && constants.has(mintConstant)) mint = constants.get(mintConstant);
    }
    return {
      symbol,
      marketIndex,
      poolId: poolIdMatch ? Number(poolIdMatch[1]) : null,
      oracle,
      oracleSource,
      mint,
    };
  }).filter((market) => Number.isFinite(market.marketIndex));
}

function accountSummary(account) {
  if (!account) return null;
  const dataLength = Array.isArray(account.data) ? Buffer.from(account.data[0], 'base64').length : null;
  return {
    owner: account.owner,
    executable: account.executable,
    lamports: account.lamports,
    dataLength,
  };
}

function parseToken2022Extensions(account) {
  if (!account || !Array.isArray(account.data)) return [];
  const data = Buffer.from(account.data[0], 'base64');
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

function optionalPubkey(bytes) {
  if (!bytes || bytes.length !== 32 || bytes.every((byte) => byte === 0)) return null;
  return base58Encode(bytes);
}

function parseToken2022TransferHook(account) {
  if (!account || !Array.isArray(account.data)) return null;
  const data = Buffer.from(account.data[0], 'base64');
  const transferHookExtension = parseToken2022Extensions(account).find((extension) => extension.type === 14 && extension.length >= 64);
  if (!transferHookExtension) return null;
  const start = transferHookExtension.offset + 4;
  return {
    authority: optionalPubkey(data.subarray(start, start + 32)),
    programId: optionalPubkey(data.subarray(start + 32, start + 64)),
  };
}

function parseToken2022TransferFee(account, epoch) {
  if (!account || !Array.isArray(account.data)) return null;
  const data = Buffer.from(account.data[0], 'base64');
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
  const active = BigInt(epoch) >= BigInt(newer.epoch) ? newer : older;
  return { older, newer, active };
}

function tokenProgramKind(owner) {
  if (owner === TOKEN_PROGRAM_ID) return 'spl-token';
  if (owner === TOKEN_2022_PROGRAM_ID) return 'token-2022';
  return owner || 'unknown';
}

async function main() {
  if (!fs.existsSync(path.dirname(OUT_FILE))) fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  const commit = execSync('git rev-parse HEAD', { cwd: TARGET, encoding: 'utf8' }).trim();
  const verifiedBuild = JSON.parse(fs.readFileSync(path.join(TARGET, '.verified-build.json'), 'utf8'));
  const perpConfigs = parseMarketConfig(path.join(TARGET, 'sdk', 'src', 'constants', 'perpMarkets.ts'), 'MainnetPerpMarkets');
  const spotConfigs = parseMarketConfig(path.join(TARGET, 'sdk', 'src', 'constants', 'spotMarkets.ts'), 'MainnetSpotMarkets');

  const statePda = findProgramAddress([Buffer.from('drift_state')], DRIFT_PROGRAM_ID);
  const perpPdas = perpConfigs.map((market) => ({
    ...market,
    pda: findProgramAddress([Buffer.from('perp_market'), u16le(market.marketIndex)], DRIFT_PROGRAM_ID),
  }));
  const spotPdas = spotConfigs.map((market) => ({
    ...market,
    pda: findProgramAddress([Buffer.from('spot_market'), u16le(market.marketIndex)], DRIFT_PROGRAM_ID),
    vaultPda: findProgramAddress([Buffer.from('spot_market_vault'), u16le(market.marketIndex)], DRIFT_PROGRAM_ID),
    insuranceFundVaultPda: findProgramAddress([Buffer.from('insurance_fund_vault'), u16le(market.marketIndex)], DRIFT_PROGRAM_ID),
  }));

  const connection = await connectRpc();
  const rpc = makeRpc(connection.url);
  const programAccount = await rpc('getAccountInfo', [DRIFT_PROGRAM_ID, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!programAccount.value) throw new Error('Drift program account not found');

  let parsedProgram = parseUpgradeableProgram(programAccount.value, null);
  let programDataAccount = null;
  if (parsedProgram.programDataAddress) {
    programDataAccount = await rpc('getAccountInfo', [parsedProgram.programDataAddress, { encoding: 'base64', commitment: 'confirmed' }]);
    parsedProgram = parseUpgradeableProgram(programAccount.value, programDataAccount.value);
  }

  const addresses = [
    statePda.address,
    ...perpPdas.map((market) => market.pda.address),
    ...spotPdas.flatMap((market) => [market.pda.address, market.vaultPda.address, market.insuranceFundVaultPda.address]),
    ...[...new Set(spotPdas.map((market) => market.mint).filter(Boolean))],
  ];
  const accounts = await getMultipleAccounts(rpc, addresses);

  const out = {
    generatedAt: new Date().toISOString(),
    chain: 'solana-mainnet-beta',
    rpcSlot: connection.slot,
    rpcEpoch: connection.epochInfo && connection.epochInfo.epoch,
    source: {
      repo: 'https://github.com/drift-labs/protocol-v2',
      path: path.relative(ROOT, TARGET),
      commit,
      verifiedBuild,
    },
    program: {
      programId: DRIFT_PROGRAM_ID,
      expectedOwner: BPF_LOADER_UPGRADEABLE,
      ...parsedProgram,
    },
    state: {
      pda: statePda.address,
      bump: statePda.bump,
      account: accountSummary(accounts.get(statePda.address)),
    },
    configCounts: {
      perps: perpConfigs.length,
      spots: spotConfigs.length,
    },
    liveCounts: {
      perpAccountsFound: perpPdas.filter((market) => accounts.get(market.pda.address)).length,
      spotAccountsFound: spotPdas.filter((market) => accounts.get(market.pda.address)).length,
      spotVaultsFound: spotPdas.filter((market) => accounts.get(market.vaultPda.address)).length,
      insuranceFundVaultsFound: spotPdas.filter((market) => accounts.get(market.insuranceFundVaultPda.address)).length,
      token2022SpotMints: spotPdas.filter((market) => tokenProgramKind(accounts.get(market.mint)?.owner) === 'token-2022').length,
    },
    perpMarkets: perpPdas.map((market) => ({
      ...market,
      account: accountSummary(accounts.get(market.pda.address)),
    })),
    spotMarkets: spotPdas.map((market) => ({
      ...market,
      account: accountSummary(accounts.get(market.pda.address)),
      vaultAccount: accountSummary(accounts.get(market.vaultPda.address)),
      insuranceFundVaultAccount: accountSummary(accounts.get(market.insuranceFundVaultPda.address)),
      mintAccount: accountSummary(accounts.get(market.mint)),
      tokenProgramKind: tokenProgramKind(accounts.get(market.mint)?.owner),
      token2022Extensions: parseToken2022Extensions(accounts.get(market.mint)),
      token2022TransferFee: parseToken2022TransferFee(accounts.get(market.mint), connection.epochInfo && connection.epochInfo.epoch),
      token2022TransferHook: parseToken2022TransferHook(accounts.get(market.mint)),
    })),
  };

  fs.writeFileSync(OUT_FILE, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`slot=${connection.slot} perps=${out.liveCounts.perpAccountsFound}/${out.configCounts.perps} spots=${out.liveCounts.spotAccountsFound}/${out.configCounts.spots} token2022SpotMints=${out.liveCounts.token2022SpotMints}`);
  console.log(`programDataSlot=${out.program.programDataSlot} upgradeAuthority=${out.program.upgradeAuthority ? 'present' : 'none'} elfSha256=${out.program.elfSha256}`);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message || err));
  process.exit(1);
});
