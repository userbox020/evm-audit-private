#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AbiCoder, getAddress, id } = require("ethers");

const WORKSPACE = path.join(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "sky-lending-live.json");
const CHAINLOG_URL = "https://chainlog.sky.money/api/mainnet/active.json";
const LLAMA_PROTOCOL_URL = "https://api.llama.fi/protocol/sky-lending";
const ADAPTER_URL = "https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/maker/index.js";
const RPC_TIMEOUT_MS = 20_000;
const PROBE_FROM = "0x000000000000000000000000000000000000dEaD";
const ZERO = "0x0000000000000000000000000000000000000000";

const ABI = AbiCoder.defaultAbiCoder();
const RAY = 10n ** 27n;
const WAD = 10n ** 18n;
const RAD = 10n ** 45n;
const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;

const CORE_KEYS = [
  "CHANGELOG",
  "MCD_VAT",
  "MCD_SPOT",
  "MCD_JUG",
  "MCD_DOG",
  "MCD_END",
  "MCD_PAUSE",
  "MCD_PAUSE_PROXY",
  "MCD_ESM",
  "MCD_IAM_AUTO_LINE",
  "ILK_REGISTRY",
  "CDP_MANAGER",
  "CDP_REGISTRY",
  "MCD_DAI",
  "MCD_JOIN_DAI",
  "MCD_POT",
  "MCD_VOW",
  "MCD_FLAP",
  "MCD_FLOP",
  "MCD_FLASH",
  "CLIPPER_MOM",
  "MCD_ADM",
  "MCD_GOV",
  "MCD_LITE_PSM_USDC_A",
  "MCD_PSM_USDC_A",
  "MCD_PSM_GUSD_A",
  "MCD_PSM_PAX_A",
];

function sanitize(text) {
  return String(text || "").replace(/https?:\/\/\S+/g, "[redacted-url]");
}

function selector(signature) {
  return id(signature).slice(0, 10);
}

function encodeCall(signature, args = [], types = []) {
  return selector(signature) + (args.length ? ABI.encode(types, args).slice(2) : "");
}

function decodeTuple(data, types) {
  if (!data || data === "0x") return null;
  try {
    return [...ABI.decode(types, data)];
  } catch (_) {
    return null;
  }
}

function decodeOne(data, types) {
  const decoded = decodeTuple(data, types);
  return decoded ? decoded[0] : null;
}

function isAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ""));
}

function normalizeAddress(value) {
  if (!isAddress(value)) return null;
  try {
    return getAddress(value);
  } catch (_) {
    return String(value).toLowerCase();
  }
}

function addressFromWord(word) {
  if (!word || word === "0x") return null;
  const hex = String(word).replace(/^0x/i, "").padStart(64, "0");
  const raw = "0x" + hex.slice(-40);
  if (/^0x0{40}$/i.test(raw)) return null;
  return normalizeAddress(raw);
}

function bytes32ToString(value) {
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return Buffer.from(value.slice(2), "hex").toString("utf8").replace(/\u0000+$/g, "");
}

function bigintJson(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function bigintOrNull(value) {
  if (value === null || value === undefined) return null;
  try {
    return BigInt(value);
  } catch (_) {
    return null;
  }
}

function asNumber(value) {
  if (value === null || value === undefined) return null;
  try {
    return Number(value);
  } catch (_) {
    return null;
  }
}

function formatUnits(raw, decimals, maxFrac = 8) {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  const value = BigInt(raw);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const fracText = frac.toString().padStart(Number(decimals), "0").replace(/0+$/g, "").slice(0, maxFrac);
  return fracText ? `${sign}${whole}.${fracText}` : `${sign}${whole}`;
}

function formatWad(raw) {
  return formatUnits(raw, 18, 10);
}

function formatRay(raw) {
  return formatUnits(raw, 27, 12);
}

function formatRad(raw) {
  return formatUnits(raw, 45, 6);
}

function annualizedRay(rate) {
  if (rate === null || rate === undefined) return null;
  const r = BigInt(rate);
  const delta = r - RAY;
  const bps = (delta * SECONDS_PER_YEAR * 10_000n) / RAY;
  return Number(bps) / 100;
}

function ratioBps(num, den) {
  if (!den || BigInt(den) === 0n) return null;
  return Number((BigInt(num || 0) * 10_000n) / BigInt(den));
}

function rayBps(ray) {
  if (ray === null || ray === undefined) return null;
  return Number((BigInt(ray) * 10_000n) / RAY);
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text || "").digest("hex");
}

async function fetchText(url, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { "user-agent": "evm-audit-sky-lending/1.0" }, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${sanitize(text.slice(0, 240))}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, timeoutMs = 25_000) {
  return JSON.parse(await fetchText(url, timeoutMs));
}

function extractRpcUrls() {
  if (!fs.existsSync(RPC_FILE)) return [];
  return [...fs.readFileSync(RPC_FILE, "utf8").matchAll(/https?:\/\/[^\s'"<>]+/g)].map((m) => m[0]);
}

async function rpcCall(url, method, params, timeoutMs = RPC_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await response.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json.result;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveEthereumRpc() {
  const candidates = [...extractRpcUrls(), "https://ethereum.publicnode.com", "https://rpc.ankr.com/eth"];
  const seen = new Set();
  for (const url of candidates) {
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const chainId = Number(BigInt(await rpcCall(url, "eth_chainId", [], 5000)));
      if (chainId === 1) return url;
    } catch (_) {
      // Never print or store RPC URLs.
    }
  }
  throw new Error("No Ethereum RPC available");
}

async function callRaw(rpc, to, signature, args = [], types = [], block = "latest", from = undefined) {
  const tx = { to, data: encodeCall(signature, args, types) };
  if (from) tx.from = from;
  return rpcCall(rpc, "eth_call", [tx, block], 10_000);
}

async function callOptional(rpc, to, signature, args = [], types = [], retTypes = null, block = "latest", from = undefined) {
  if (!isAddress(to)) return { ok: false, value: null, raw: null, error: "BAD_ADDRESS" };
  try {
    const raw = await callRaw(rpc, to, signature, args, types, block, from);
    if (!raw || raw === "0x") return { ok: false, value: null, raw, error: "EMPTY" };
    const value = retTypes ? decodeTuple(raw, retTypes) : raw;
    if (retTypes && value === null) return { ok: false, value: null, raw, error: "DECODE" };
    return { ok: true, value, raw, error: null };
  } catch (err) {
    return { ok: false, value: null, raw: null, error: sanitize(err.message || err).slice(0, 180) };
  }
}

async function stateProbe(rpc, to, signature, args = [], types = []) {
  try {
    const raw = await callRaw(rpc, to, signature, args, types, "latest", PROBE_FROM);
    return { success: true, result: raw && raw.length > 66 ? `${raw.slice(0, 66)}...` : raw };
  } catch (err) {
    return { success: false, error: sanitize(err.message || err).slice(0, 180) };
  }
}

async function getBlock(rpc) {
  const blockNumber = Number(BigInt(await rpcCall(rpc, "eth_blockNumber", [])));
  const block = await rpcCall(rpc, "eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
  return { number: blockNumber, timestamp: Number(BigInt(block.timestamp)) };
}

async function getCodeSummary(rpc, address) {
  if (!isAddress(address)) return { address, codePresent: false, codeBytes: 0, codeHash: null };
  const code = await rpcCall(rpc, "eth_getCode", [address, "latest"]).catch(() => "0x");
  return {
    address: normalizeAddress(address),
    codePresent: Boolean(code && code !== "0x"),
    codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0,
    codeHash: code && code !== "0x" ? sha256Hex(code) : null,
  };
}

async function wardMap(rpc, address, subjects) {
  const out = {};
  if (!isAddress(address)) return out;
  for (const [label, subject] of subjects) {
    if (!isAddress(subject)) continue;
    const res = await callOptional(rpc, address, "wards(address)", [subject], ["address"], ["uint256"]);
    if (res.ok) out[label] = res.value[0].toString();
  }
  return out;
}

async function fetchMetadata() {
  const [protocolResult, adapterResult] = await Promise.allSettled([
    fetchJson(LLAMA_PROTOCOL_URL, 35_000),
    fetchText(ADAPTER_URL, 25_000),
  ]);

  const protocol = protocolResult.status === "fulfilled" ? summarizeLlama(protocolResult.value) : { error: sanitize(protocolResult.reason?.message || protocolResult.reason) };
  const adapterText = adapterResult.status === "fulfilled" ? adapterResult.value : null;
  const adapter = adapterText
    ? {
        path: "projects/maker/index.js",
        url: ADAPTER_URL,
        sha256: sha256Hex(adapterText),
        bytes: Buffer.byteLength(adapterText),
        references: {
          mcdVat: /MCD_VAT\s*=\s*['"]([^'"]+)/.exec(adapterText)?.[1] || null,
          mcdDog: /MCD_DOG\s*=\s*['"]([^'"]+)/.exec(adapterText)?.[1] || null,
          extraUsdcWallet: /extraUSDCWallet\s*=\s*['"]([^'"]+)/.exec(adapterText)?.[1] || null,
          startVatBlock: /START_VAT_BLOCK\s*=\s*([0-9]+)/.exec(adapterText)?.[1] || null,
          startDogBlock: /START_DOG_BLOCK\s*=\s*([0-9]+)/.exec(adapterText)?.[1] || null,
        },
      }
    : { path: "projects/maker/index.js", error: sanitize(adapterResult.reason?.message || adapterResult.reason) };

  return { protocol, adapter };
}

function summarizeLlama(protocol) {
  const chainTvls = {};
  const current = protocol.currentChainTvls || {};
  for (const [chain, value] of Object.entries(current)) {
    if (typeof value === "number") chainTvls[chain] = value;
  }
  const latestTvl = Array.isArray(protocol.tvl) && protocol.tvl.length ? protocol.tvl[protocol.tvl.length - 1] : null;
  return {
    id: protocol.id,
    name: protocol.name,
    slug: protocol.slug,
    category: protocol.category,
    chains: protocol.chains,
    audits: protocol.audits,
    audit_links: protocol.audit_links,
    latestTvlUsd: latestTvl?.totalLiquidityUSD ?? protocol.tvl?.totalLiquidityUSD ?? null,
    latestTvlDate: latestTvl?.date ?? null,
    currentChainTvls: chainTvls,
    methodology: protocol.methodology,
  };
}

function extractCoreAddresses(chainlog) {
  const core = {};
  for (const key of CORE_KEYS) {
    if (isAddress(chainlog[key])) core[key] = normalizeAddress(chainlog[key]);
  }
  return core;
}

function keyForIlk(prefix, ilkName) {
  return `${prefix}_${ilkName.replace(/-/g, "_")}`;
}

async function scanCore(rpc, core) {
  const subjects = [
    ["pauseProxy", core.MCD_PAUSE_PROXY],
    ["governance", core.MCD_ADM],
    ["esm", core.MCD_ESM],
    ["end", core.MCD_END],
    ["probe", PROBE_FROM],
  ];
  const contracts = {};
  for (const [key, address] of Object.entries(core)) {
    contracts[key] = {
      ...(await getCodeSummary(rpc, address)),
      wards: await wardMap(rpc, address, subjects),
    };
  }

  const vat = core.MCD_VAT;
  const spot = core.MCD_SPOT;
  const jug = core.MCD_JUG;
  const dog = core.MCD_DOG;
  const pause = core.MCD_PAUSE;
  const esm = core.MCD_ESM;
  const views = {
    vat: await viewMap(rpc, vat, {
      live: ["live()", [], [], ["uint256"]],
      Line: ["Line()", [], [], ["uint256"]],
      debt: ["debt()", [], [], ["uint256"]],
      vice: ["vice()", [], [], ["uint256"]],
    }),
    spot: await viewMap(rpc, spot, {
      live: ["live()", [], [], ["uint256"]],
      par: ["par()", [], [], ["uint256"]],
    }),
    jug: await viewMap(rpc, jug, {
      live: ["live()", [], [], ["uint256"]],
      base: ["base()", [], [], ["uint256"]],
    }),
    dog: await viewMap(rpc, dog, {
      live: ["live()", [], [], ["uint256"]],
      Hole: ["Hole()", [], [], ["uint256"]],
      Dirt: ["Dirt()", [], [], ["uint256"]],
    }),
    pause: await viewMap(rpc, pause, {
      delay: ["delay()", [], [], ["uint256"]],
    }),
    esm: await viewMap(rpc, esm, {
      live: ["live()", [], [], ["uint256"]],
      min: ["min()", [], [], ["uint256"]],
      Sum: ["Sum()", [], [], ["uint256"]],
      sum: ["sum()", [], [], ["uint256"]],
    }),
  };

  const probes = {
    vatRelyProbe: await stateProbe(rpc, vat, "rely(address)", [PROBE_FROM], ["address"]),
    vatFileLineProbe: await stateProbe(rpc, vat, "file(bytes32,uint256)", [toBytes32("Line"), 0], ["bytes32", "uint256"]),
    spotRelyProbe: await stateProbe(rpc, spot, "rely(address)", [PROBE_FROM], ["address"]),
    jugRelyProbe: await stateProbe(rpc, jug, "rely(address)", [PROBE_FROM], ["address"]),
    dogRelyProbe: await stateProbe(rpc, dog, "rely(address)", [PROBE_FROM], ["address"]),
    dogCageProbe: await stateProbe(rpc, dog, "cage()"),
    endCageProbe: await stateProbe(rpc, core.MCD_END, "cage()"),
    pauseRelyProbe: await stateProbe(rpc, pause, "rely(address)", [PROBE_FROM], ["address"]),
  };

  return { contracts, views, probes };
}

async function viewMap(rpc, address, spec) {
  const out = {};
  for (const [name, [signature, args, types, retTypes]] of Object.entries(spec)) {
    const res = await callOptional(rpc, address, signature, args, types, retTypes);
    if (res.ok) out[name] = scalarize(res.value[0]);
  }
  return out;
}

function scalarize(value) {
  if (typeof value === "bigint") return value.toString();
  if (isAddress(value)) return normalizeAddress(value);
  return value;
}

function toBytes32(text) {
  const hex = Buffer.from(text, "utf8").toString("hex");
  return "0x" + hex.padEnd(64, "0").slice(0, 64);
}

async function scanIlks(rpc, chainlog, core, block) {
  const registry = core.ILK_REGISTRY;
  const listRes = await callOptional(rpc, registry, "list()", [], [], ["bytes32[]"]);
  if (!listRes.ok) throw new Error(`ILK_REGISTRY list() failed: ${listRes.error}`);
  const ilkIds = listRes.value[0];
  const results = [];

  for (const ilk of ilkIds) {
    const ilkName = bytes32ToString(ilk);
    const info = await scanIlkInfo(rpc, registry, ilk);
    const vat = await scanVatIlk(rpc, core.MCD_VAT, ilk);
    const spot = await scanSpotIlk(rpc, core.MCD_SPOT, ilk);
    const jug = await scanJugIlk(rpc, core.MCD_JUG, ilk, block.timestamp);
    const dog = await scanDogIlk(rpc, core.MCD_DOG, ilk);
    const autoLine = core.MCD_IAM_AUTO_LINE ? await scanAutoLineIlk(rpc, core.MCD_IAM_AUTO_LINE, ilk) : null;

    const joinAddress = info?.join || normalizeAddress(chainlog[keyForIlk("MCD_JOIN", ilkName)] || ZERO);
    const clipAddress = dog?.clip || info?.xlip || normalizeAddress(chainlog[keyForIlk("MCD_CLIP", ilkName)] || ZERO);
    const calcAddress = normalizeAddress(chainlog[keyForIlk("MCD_CLIP_CALC", ilkName)] || ZERO);
    const psmAddress = normalizeAddress(chainlog[keyForIlk("MCD_PSM", ilkName)] || ZERO);
    const pipAddress = spot?.pip || info?.pip || normalizeAddress(chainlog[`PIP_${ilkName.split("-")[0]}`] || ZERO);

    const [join, clip, calc, psm, oracle] = await Promise.all([
      scanJoin(rpc, joinAddress),
      scanClip(rpc, clipAddress),
      scanCalc(rpc, calcAddress),
      scanPsm(rpc, psmAddress),
      scanOracle(rpc, pipAddress, core.MCD_SPOT, block),
    ]);

    const activeAuctions = clip?.kicksRaw ? await scanActiveAuctions(rpc, clipAddress, BigInt(clip.kicksRaw), 20) : [];
    const row = {
      ilk,
      ilkName,
      category: categorizeIlk(ilkName, info),
      chainlog: {
        joinKey: keyForIlk("MCD_JOIN", ilkName),
        join: normalizeAddress(chainlog[keyForIlk("MCD_JOIN", ilkName)] || ZERO),
        clipKey: keyForIlk("MCD_CLIP", ilkName),
        clip: normalizeAddress(chainlog[keyForIlk("MCD_CLIP", ilkName)] || ZERO),
        calcKey: keyForIlk("MCD_CLIP_CALC", ilkName),
        calc: normalizeAddress(chainlog[keyForIlk("MCD_CLIP_CALC", ilkName)] || ZERO),
        psmKey: keyForIlk("MCD_PSM", ilkName),
        psm: psmAddress,
      },
      info,
      vat,
      spot,
      jug,
      dog,
      autoLine,
      join,
      psm,
      clip: clip ? { ...clip, activeAuctions } : null,
      calc,
      oracle,
      economics: computeIlkEconomics(vat, spot, jug, dog, autoLine),
      flags: [],
    };
    row.flags = evaluateIlk(row, block);
    results.push(row);
  }
  return results;
}

async function scanIlkInfo(rpc, registry, ilk) {
  const res = await callOptional(
    rpc,
    registry,
    "info(bytes32)",
    [ilk],
    ["bytes32"],
    ["string", "string", "uint256", "uint256", "address", "address", "address", "address"],
  );
  if (!res.ok) return null;
  const [name, symbol, classId, decimals, gem, pip, join, xlip] = res.value;
  return {
    name,
    symbol,
    classId: classId.toString(),
    decimals: decimals.toString(),
    gem: normalizeAddress(gem),
    pip: normalizeAddress(pip),
    join: normalizeAddress(join),
    xlip: normalizeAddress(xlip),
  };
}

async function scanVatIlk(rpc, vat, ilk) {
  const res = await callOptional(rpc, vat, "ilks(bytes32)", [ilk], ["bytes32"], ["uint256", "uint256", "uint256", "uint256", "uint256"]);
  if (!res.ok) return null;
  const [Art, rate, spot, line, dust] = res.value;
  const debtRad = Art * rate;
  return {
    ArtRaw: Art.toString(),
    Art: formatWad(Art),
    rateRaw: rate.toString(),
    rate: formatRay(rate),
    spotRaw: spot.toString(),
    spot: formatRay(spot),
    lineRaw: line.toString(),
    lineDai: formatRad(line),
    dustRaw: dust.toString(),
    dustDai: formatRad(dust),
    debtRaw: debtRad.toString(),
    debtDai: formatRad(debtRad),
  };
}

async function scanSpotIlk(rpc, spot, ilk) {
  const res = await callOptional(rpc, spot, "ilks(bytes32)", [ilk], ["bytes32"], ["address", "uint256"]);
  if (!res.ok) return null;
  const [pip, mat] = res.value;
  return {
    pip: normalizeAddress(pip),
    matRaw: mat.toString(),
    mat: formatRay(mat),
    matBps: rayBps(mat),
  };
}

async function scanJugIlk(rpc, jug, ilk, timestamp) {
  const res = await callOptional(rpc, jug, "ilks(bytes32)", [ilk], ["bytes32"], ["uint256", "uint256"]);
  if (!res.ok) return null;
  const [duty, rho] = res.value;
  return {
    dutyRaw: duty.toString(),
    duty: formatRay(duty),
    dutyApproxAprPct: annualizedRay(duty),
    rho: rho.toString(),
    rhoAgeSeconds: timestamp - Number(rho),
  };
}

async function scanDogIlk(rpc, dog, ilk) {
  const res = await callOptional(rpc, dog, "ilks(bytes32)", [ilk], ["bytes32"], ["address", "uint256", "uint256", "uint256"]);
  if (!res.ok) return null;
  const [clip, chop, hole, dirt] = res.value;
  return {
    clip: normalizeAddress(clip),
    chopRaw: chop.toString(),
    chop: formatWad(chop),
    chopBps: Number((chop * 10_000n) / WAD),
    holeRaw: hole.toString(),
    holeDai: formatRad(hole),
    dirtRaw: dirt.toString(),
    dirtDai: formatRad(dirt),
  };
}

async function scanAutoLineIlk(rpc, autoLine, ilk) {
  const res = await callOptional(rpc, autoLine, "ilks(bytes32)", [ilk], ["bytes32"], ["uint256", "uint256", "uint256", "uint256", "uint256"]);
  if (!res.ok) return null;
  const [line, gap, ttl, last, lastInc] = res.value;
  return {
    lineRaw: line.toString(),
    lineDai: formatRad(line),
    gapRaw: gap.toString(),
    gapDai: formatRad(gap),
    ttl: ttl.toString(),
    last: last.toString(),
    lastInc: lastInc.toString(),
  };
}

async function scanJoin(rpc, join) {
  if (!isAddress(join) || join.toLowerCase() === ZERO.toLowerCase()) return null;
  const [code, views] = await Promise.all([
    getCodeSummary(rpc, join),
    viewMap(rpc, join, {
      vat: ["vat()", [], [], ["address"]],
      ilk: ["ilk()", [], [], ["bytes32"]],
      gem: ["gem()", [], [], ["address"]],
      dec: ["dec()", [], [], ["uint256"]],
      live: ["live()", [], [], ["uint256"]],
    }),
  ]);
  return { ...code, views: normalizeViewValues(views) };
}

async function scanPsm(rpc, psm) {
  if (!isAddress(psm) || psm.toLowerCase() === ZERO.toLowerCase()) return null;
  const [code, views] = await Promise.all([
    getCodeSummary(rpc, psm),
    viewMap(rpc, psm, {
      vat: ["vat()", [], [], ["address"]],
      gemJoin: ["gemJoin()", [], [], ["address"]],
      daiJoin: ["daiJoin()", [], [], ["address"]],
      vow: ["vow()", [], [], ["address"]],
      tin: ["tin()", [], [], ["uint256"]],
      tout: ["tout()", [], [], ["uint256"]],
    }),
  ]);
  return { ...code, views: normalizeViewValues(views) };
}

async function scanClip(rpc, clip) {
  if (!isAddress(clip) || clip.toLowerCase() === ZERO.toLowerCase()) return null;
  const [code, views, probes] = await Promise.all([
    getCodeSummary(rpc, clip),
    viewMap(rpc, clip, {
      vat: ["vat()", [], [], ["address"]],
      dog: ["dog()", [], [], ["address"]],
      vow: ["vow()", [], [], ["address"]],
      spotter: ["spotter()", [], [], ["address"]],
      calc: ["calc()", [], [], ["address"]],
      ilk: ["ilk()", [], [], ["bytes32"]],
      buf: ["buf()", [], [], ["uint256"]],
      tail: ["tail()", [], [], ["uint256"]],
      cusp: ["cusp()", [], [], ["uint256"]],
      chip: ["chip()", [], [], ["uint256"]],
      tip: ["tip()", [], [], ["uint256"]],
      chost: ["chost()", [], [], ["uint256"]],
      kicks: ["kicks()", [], [], ["uint256"]],
      stopped: ["stopped()", [], [], ["uint256"]],
    }),
    stateProbe(rpc, clip, "rely(address)", [PROBE_FROM], ["address"]),
  ]);
  const normalized = normalizeViewValues(views);
  return {
    ...code,
    ...formatClipViews(normalized),
    relyProbe: probes,
  };
}

function formatClipViews(views) {
  const out = { views };
  if (views.kicks !== undefined) out.kicksRaw = views.kicks;
  if (views.stopped !== undefined) out.stopped = views.stopped;
  if (views.buf !== undefined) out.buf = formatRay(views.buf);
  if (views.cusp !== undefined) out.cusp = formatRay(views.cusp);
  if (views.chip !== undefined) out.chip = formatWad(views.chip);
  if (views.tip !== undefined) out.tipDai = formatRad(views.tip);
  if (views.chost !== undefined) out.chostDai = formatRad(views.chost);
  return out;
}

async function scanCalc(rpc, calc) {
  if (!isAddress(calc) || calc.toLowerCase() === ZERO.toLowerCase()) return null;
  const [code, views] = await Promise.all([
    getCodeSummary(rpc, calc),
    viewMap(rpc, calc, {
      tau: ["tau()", [], [], ["uint256"]],
      cut: ["cut()", [], [], ["uint256"]],
      step: ["step()", [], [], ["uint256"]],
    }),
  ]);
  return { ...code, views: normalizeViewValues(views) };
}

function normalizeViewValues(views) {
  const out = {};
  for (const [key, value] of Object.entries(views || {})) {
    if (typeof value === "bigint") out[key] = value.toString();
    else if (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)) out[key] = bytes32ToString(value) || value;
    else if (isAddress(value)) out[key] = normalizeAddress(value);
    else out[key] = value;
  }
  return out;
}

async function scanOracle(rpc, pip, spotter, block) {
  if (!isAddress(pip) || pip.toLowerCase() === ZERO.toLowerCase()) return null;
  const code = await getCodeSummary(rpc, pip);
  const calls = await viewMap(rpc, pip, {
    src: ["src()", [], [], ["address"]],
    zzz: ["zzz()", [], [], ["uint256"]],
    hop: ["hop()", [], [], ["uint256"]],
    stopped: ["stopped()", [], [], ["uint256"]],
  });
  const [peek, peep, cur, nxt, read, spotBud, probeBud, pokeProbe, latest] = await Promise.all([
    callOptional(rpc, pip, "peek()", [], [], ["bytes32", "bool"]),
    callOptional(rpc, pip, "peep()", [], [], ["bytes32", "bool"]),
    callOptional(rpc, pip, "cur()", [], [], ["bytes32", "bool"]),
    callOptional(rpc, pip, "nxt()", [], [], ["bytes32", "bool"]),
    callOptional(rpc, pip, "read()", [], [], ["bytes32"]),
    callOptional(rpc, pip, "bud(address)", [spotter || ZERO], ["address"], ["uint256"]),
    callOptional(rpc, pip, "bud(address)", [PROBE_FROM], ["address"], ["uint256"]),
    stateProbe(rpc, pip, "poke()"),
    scanLatestRoundData(rpc, pip),
  ]);

  const out = {
    ...code,
    views: normalizeViewValues(calls),
    peek: decodeOracleTuple(peek),
    peep: decodeOracleTuple(peep),
    cur: decodeOracleTuple(cur),
    nxt: decodeOracleTuple(nxt),
    read: read.ok ? decodeOracleWord(read.value[0]) : null,
    spotterBud: spotBud.ok ? spotBud.value[0].toString() : null,
    probeBud: probeBud.ok ? probeBud.value[0].toString() : null,
    pokeProbe,
    latestRoundData: latest,
    flags: [],
  };

  const zzz = bigintOrNull(calls.zzz);
  const hop = bigintOrNull(calls.hop);
  if (zzz !== null) out.zzzAgeSeconds = block.timestamp - Number(zzz);
  if (zzz !== null && hop !== null) out.isOsmStale = out.zzzAgeSeconds > Number(hop) * 2 + 60;

  const src = normalizeAddress(calls.src);
  if (src) out.source = await scanOracleSource(rpc, src, block);
  out.flags = evaluateOracle(out);
  return out;
}

function decodeOracleTuple(res) {
  if (!res.ok) return null;
  const [word, ok] = res.value;
  const decoded = decodeOracleWord(word);
  return { ...decoded, has: ok };
}

function decodeOracleWord(word) {
  if (!word || !/^0x[0-9a-fA-F]{64}$/.test(word)) return { raw: null, wad: null };
  const raw = BigInt(word);
  return { raw: raw.toString(), wad: formatWad(raw) };
}

async function scanOracleSource(rpc, source, block) {
  const [code, peek, read, latest, views] = await Promise.all([
    getCodeSummary(rpc, source),
    callOptional(rpc, source, "peek()", [], [], ["bytes32", "bool"]),
    callOptional(rpc, source, "read()", [], [], ["bytes32"]),
    scanLatestRoundData(rpc, source, block),
    viewMap(rpc, source, {
      age: ["age()", [], [], ["uint32"]],
      wat: ["wat()", [], [], ["bytes32"]],
      bar: ["bar()", [], [], ["uint256"]],
      stopped: ["stopped()", [], [], ["uint256"]],
    }),
  ]);
  return {
    ...code,
    peek: decodeOracleTuple(peek),
    read: read.ok ? decodeOracleWord(read.value[0]) : null,
    latestRoundData: latest,
    views: normalizeViewValues(views),
  };
}

async function scanLatestRoundData(rpc, address, block) {
  const res = await callOptional(rpc, address, "latestRoundData()", [], [], ["uint80", "int256", "uint256", "uint256", "uint80"]);
  if (!res.ok) return null;
  const [roundId, answer, startedAt, updatedAt, answeredInRound] = res.value;
  const decimals = await callOptional(rpc, address, "decimals()", [], [], ["uint8"]);
  const dec = decimals.ok ? Number(decimals.value[0]) : null;
  return {
    roundId: roundId.toString(),
    answer: answer.toString(),
    answerFormatted: answer >= 0n && dec !== null ? formatUnits(answer, dec, 10) : null,
    startedAt: startedAt.toString(),
    updatedAt: updatedAt.toString(),
    answeredInRound: answeredInRound.toString(),
    ageSeconds: block && updatedAt > 0n ? block.timestamp - Number(updatedAt) : null,
    decimals: dec,
  };
}

function evaluateOracle(oracle) {
  const flags = [];
  if (!oracle.codePresent) flags.push("PIP_NO_CODE");
  if (oracle.peek && oracle.peek.has === false) flags.push("PEEK_FALSE");
  if (oracle.cur && oracle.cur.has === false) flags.push("CUR_FALSE");
  if (oracle.nxt && oracle.nxt.has === false) flags.push("NXT_FALSE");
  if (oracle.isOsmStale) flags.push("OSM_ZZZ_STALE_GT_2_HOPS");
  if (oracle.spotterBud !== null && oracle.spotterBud !== "1") flags.push("SPOTTER_NOT_BUD");
  if (oracle.probeBud === "1") flags.push("PROBE_IS_BUD");
  if (oracle.latestRoundData && oracle.latestRoundData.answer !== null && BigInt(oracle.latestRoundData.answer) <= 0n) flags.push("CHAINLINK_NON_POSITIVE");
  if (oracle.latestRoundData?.ageSeconds !== null && oracle.latestRoundData?.ageSeconds > 86_400) flags.push("CHAINLINK_AGE_GT_24H");
  return flags;
}

async function scanActiveAuctions(rpc, clip, kicks, limit) {
  const active = [];
  if (!isAddress(clip) || kicks === 0n) return active;
  const start = kicks > BigInt(limit) ? kicks - BigInt(limit) + 1n : 1n;
  for (let idNum = start; idNum <= kicks; idNum++) {
    const idValue = idNum.toString();
    const sale = await callOptional(rpc, clip, "sales(uint256)", [idValue], ["uint256"], ["uint256", "uint256", "uint256", "address", "uint256", "uint256"]);
    if (!sale.ok) continue;
    const [pos, tab, lot, usr, tic, top] = sale.value;
    if (pos === 0n && tab === 0n && lot === 0n) continue;
    const status = await callOptional(rpc, clip, "getStatus(uint256)", [idValue], ["uint256"], ["bool", "uint256", "uint256", "uint256"]);
    active.push({
      id: idValue,
      pos: pos.toString(),
      tabRaw: tab.toString(),
      tabDai: formatRad(tab),
      lotRaw: lot.toString(),
      lot: formatWad(lot),
      usr: normalizeAddress(usr),
      tic: tic.toString(),
      topRaw: top.toString(),
      top: formatRay(top),
      status: status.ok
        ? {
            needsRedo: status.value[0],
            priceRaw: status.value[1].toString(),
            price: formatRay(status.value[1]),
            lotRaw: status.value[2].toString(),
            tabRaw: status.value[3].toString(),
          }
        : null,
    });
  }
  return active;
}

function categorizeIlk(ilkName, info) {
  if (ilkName.includes("PSM")) return "psm";
  if (ilkName.startsWith("RWA")) return "rwa";
  if (ilkName.startsWith("DIRECT-")) return "direct";
  if (ilkName.startsWith("ALLOCATOR-")) return "allocator";
  if (ilkName.startsWith("TELEPORT-")) return "teleport";
  if (ilkName.startsWith("LSE") || info?.symbol === "SKY") return "lockstake";
  if (info?.symbol?.startsWith("UNIV2") || ilkName.startsWith("UNIV2") || ilkName.startsWith("GUNIV3")) return "lp";
  return "cdp";
}

function computeIlkEconomics(vat, spot, jug, dog, autoLine) {
  const Art = bigintOrNull(vat?.ArtRaw) || 0n;
  const rate = bigintOrNull(vat?.rateRaw) || 0n;
  const debt = bigintOrNull(vat?.debtRaw) || Art * rate;
  const line = bigintOrNull(vat?.lineRaw) || 0n;
  const hole = bigintOrNull(dog?.holeRaw) || 0n;
  const dirt = bigintOrNull(dog?.dirtRaw) || 0n;
  const autoLineRaw = bigintOrNull(autoLine?.lineRaw);
  return {
    debtDai: formatRad(debt),
    lineDai: formatRad(line),
    lineUtilizationBps: ratioBps(debt, line),
    lineHeadroomDai: line >= debt ? formatRad(line - debt) : `-${formatRad(debt - line)}`,
    liquidationHoleDai: formatRad(hole),
    liquidationDirtDai: formatRad(dirt),
    liquidationHoleUtilizationBps: ratioBps(dirt, hole),
    matBps: spot?.matBps ?? null,
    liquidationPenaltyBps: dog?.chopBps ?? null,
    stabilityFeeApproxAprPct: jug?.dutyApproxAprPct ?? null,
    autoLineDai: autoLineRaw !== null ? formatRad(autoLineRaw) : null,
  };
}

function evaluateIlk(row, block) {
  const flags = [];
  const line = bigintOrNull(row.vat?.lineRaw) || 0n;
  const debt = bigintOrNull(row.vat?.debtRaw) || 0n;
  const art = bigintOrNull(row.vat?.ArtRaw) || 0n;
  const isActive = line > 0n || debt > 0n || art > 0n;
  const isPublicCdp = row.category === "cdp" || row.category === "lp";
  if (line > 0n) flags.push("LINE_POSITIVE");
  if (debt > 0n) flags.push("DEBT_POSITIVE");
  if (line > 0n && debt > line) flags.push("DEBT_EXCEEDS_LINE");
  if (line > 0n && isPublicCdp && (!row.spot || bigintOrNull(row.spot.matRaw) === 0n)) flags.push("PUBLIC_CDP_ACTIVE_LINE_ZERO_MAT");
  if (line > 0n && isPublicCdp && (!row.vat || bigintOrNull(row.vat.spotRaw) === 0n)) flags.push("PUBLIC_CDP_ACTIVE_LINE_ZERO_VAT_SPOT");
  if (isActive && isPublicCdp && (!row.join || !row.join.codePresent)) flags.push("PUBLIC_CDP_ACTIVE_JOIN_NO_CODE");
  if (line > 0n && row.join?.views?.live === "0") flags.push("ACTIVE_JOIN_NOT_LIVE");
  if (line > 0n && row.oracle?.flags?.length) flags.push(...row.oracle.flags.map((f) => `ORACLE_${f}`));
  if (line > 0n && isPublicCdp && (!row.clip || !row.clip.codePresent)) flags.push("PUBLIC_CDP_ACTIVE_CLIP_NO_CODE");
  if (line > 0n && isPublicCdp && row.clip?.stopped && row.clip.stopped !== "0") flags.push("PUBLIC_CDP_CLIP_STOPPED");
  if (row.clip?.activeAuctions?.length) flags.push("ACTIVE_CLIPPER_AUCTIONS_RECENT_WINDOW");
  if (isPublicCdp && row.jug?.rhoAgeSeconds !== null && row.jug?.rhoAgeSeconds > 7 * 24 * 3600 && debt > 0n) flags.push("PUBLIC_CDP_JUG_RHO_GT_7D_WITH_DEBT");
  if (row.oracle?.zzzAgeSeconds !== undefined && row.oracle.zzzAgeSeconds > 2 * Number(row.oracle.views?.hop || 0) + 60 && line > 0n) flags.push("ACTIVE_ORACLE_ZZZ_STALE");
  if (row.oracle?.latestRoundData?.ageSeconds !== null && row.oracle?.latestRoundData?.ageSeconds > 24 * 3600 && line > 0n) flags.push("ACTIVE_CHAINLINK_AGE_GT_24H");
  if (block && row.clip?.activeAuctions?.some((sale) => sale.status?.needsRedo)) flags.push("AUCTION_NEEDS_REDO");
  return [...new Set(flags)];
}

function summarize(results, coreScan, block) {
  const active = results.filter((r) => BigInt(r.vat?.lineRaw || 0) > 0n);
  const debt = results.filter((r) => BigInt(r.vat?.debtRaw || 0) > 0n);
  const publicCdpActive = active.filter((r) => r.category === "cdp" || r.category === "lp");
  const oracleFlagged = results.filter((r) => r.flags.some((f) => f.startsWith("ORACLE_") || f.includes("ORACLE")));
  const activeAuctions = results.flatMap((r) => (r.clip?.activeAuctions || []).map((a) => ({ ilkName: r.ilkName, ...a })));
  const unauthorizedProbeSuccesses = Object.entries(coreScan.probes || {}).filter(([, probe]) => probe.success).map(([name, probe]) => ({ name, probe }));
  return {
    block,
    counts: {
      ilks: results.length,
      activeLineIlks: active.length,
      debtIlks: debt.length,
      publicCdpActiveIlks: publicCdpActive.length,
      oracleFlaggedIlks: oracleFlagged.length,
      activeRecentAuctions: activeAuctions.length,
      unauthorizedProbeSuccesses: unauthorizedProbeSuccesses.length,
    },
    globalDebtDai: formatRad(coreScan.views?.vat?.debt || 0),
    globalDebtCeilingDai: formatRad(coreScan.views?.vat?.Line || 0),
    globalLineUtilizationBps: ratioBps(coreScan.views?.vat?.debt || 0, coreScan.views?.vat?.Line || 0),
    globalHoleDai: formatRad(coreScan.views?.dog?.Hole || 0),
    globalDirtDai: formatRad(coreScan.views?.dog?.Dirt || 0),
    globalHoleUtilizationBps: ratioBps(coreScan.views?.dog?.Dirt || 0, coreScan.views?.dog?.Hole || 0),
    activeAuctions,
    unauthorizedProbeSuccesses,
    flaggedIlks: results.filter((r) => r.flags.some((f) => !["LINE_POSITIVE", "DEBT_POSITIVE"].includes(f))).map((r) => ({ ilkName: r.ilkName, category: r.category, flags: r.flags })),
    topDebtIlks: [...results]
      .sort((a, b) => (BigInt(b.vat?.debtRaw || 0) > BigInt(a.vat?.debtRaw || 0) ? 1 : -1))
      .slice(0, 12)
      .map((r) => ({ ilkName: r.ilkName, category: r.category, debtDai: r.vat?.debtDai, lineDai: r.vat?.lineDai, utilBps: r.economics.lineUtilizationBps, flags: r.flags })),
  };
}

function printSummary(out) {
  const s = out.summary;
  console.log(`Sky Lending live scan complete at Ethereum block ${s.block.number}`);
  console.log(`Ilks: ${s.counts.ilks}; active lines: ${s.counts.activeLineIlks}; debt ilks: ${s.counts.debtIlks}; public CDP active: ${s.counts.publicCdpActiveIlks}`);
  console.log(`Global debt: ${s.globalDebtDai} Dai; debt ceiling: ${s.globalDebtCeilingDai} Dai; line util bps: ${s.globalLineUtilizationBps}`);
  console.log(`Oracle-flagged ilks: ${s.counts.oracleFlaggedIlks}; recent active auctions: ${s.counts.activeRecentAuctions}; unauthorized probe successes: ${s.counts.unauthorizedProbeSuccesses}`);
  if (s.flaggedIlks.length) {
    console.log("Flagged ilks:");
    for (const row of s.flaggedIlks.slice(0, 20)) console.log(`- ${row.ilkName}: ${row.flags.join(",")}`);
  }
  console.log(`Wrote ${OUT}`);
}

async function main() {
  const rpc = await resolveEthereumRpc();
  const [metadata, chainlog, block] = await Promise.all([fetchMetadata(), fetchJson(CHAINLOG_URL), getBlock(rpc)]);
  const core = extractCoreAddresses(chainlog);
  const coreScan = await scanCore(rpc, core);
  const ilks = await scanIlks(rpc, chainlog, core, block);
  const out = {
    generatedAt: new Date().toISOString(),
    target: "Sky Lending / Maker-Sky core CDP",
    metadata,
    chainlog: {
      url: CHAINLOG_URL,
      keyCount: Object.keys(chainlog).length,
      core,
    },
    core: coreScan,
    ilks,
    summary: null,
  };
  out.summary = summarize(ilks, coreScan, block);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, bigintJson, 2));
  printSummary(out);
}

main().catch((err) => {
  console.error(sanitize(err.stack || err.message || err));
  process.exit(1);
});
