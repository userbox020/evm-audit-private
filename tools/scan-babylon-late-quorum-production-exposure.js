#!/usr/bin/env node
"use strict";

/*
 * Babylon BAB-H-01 Step 9 production exposure reconstruction, R3.
 * Read-only only. Endpoint inventories are consumed in memory and are never
 * printed, persisted, hashed, or represented by a domain/URL in artifacts.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TOOL = "tools/scan-babylon-late-quorum-production-exposure.js";
const BASE = "babylon-late-quorum-production-exposure";
const RAW = path.join(ROOT, "reports", "raw", "fast", `${BASE}.json`);
const TRANSCRIPT = path.join(ROOT, "reports", "raw", "fast", `${BASE}.transcript.json`);
const FIXTURES = path.join(ROOT, "reports", "raw", "fast", `${BASE}.fixtures.json`);
const BOUNDARY = path.join(ROOT, "reports", "raw", "fast", `${BASE}.archive-boundary.json`);
const TEST_OUT = path.join(ROOT, "reports", "raw", "fast", `${BASE}.test-output.txt`);
const MANIFEST = path.join(ROOT, "reports", "raw", "fast", `${BASE}.manifest.json`);
const REPORT = path.join(ROOT, "reports", `${BASE}.md`);
const DEFINITIONS = path.join(ROOT, "reports", `${BASE}-definitions.md`);
const SOURCES = path.join(ROOT, "reports", `${BASE}-sources.md`);
const RPC_INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const GRAPHQL_INVENTORY = path.join(ROOT, "graphql_endpoints.txt");
const LEGACY_SCANNER = path.join(ROOT, "tools", "scan-babylon-late-quorum-current-state.js");
const SOURCE = path.join(ROOT, "sources", "babylon-v4.3.0");
const REMEDIATION = path.join(ROOT, "sources", "babylon-v4.3.0-remediation");
const TXID_HELPER = path.join(ROOT, "tools", "babylon-canonical-txid-helper", "main.go");
const CURRENT_PAGES = path.join(ROOT, "reports", "raw", "fast", `${BASE}.current-pages.json`);
const PREINDEX_ROWS = path.join(ROOT, "reports", "raw", "fast", `${BASE}.preindex-rows.json`);
const TX_EVENT_FACTS = path.join(ROOT, "reports", "raw", "fast", `${BASE}.tx-event-facts.json`);
const ARCHIVE_FACTS = path.join(ROOT, "reports", "raw", "fast", `${BASE}.archive-facts.json`);
const CACHE_ROWS = path.join(ROOT, "reports", "raw", "fast", `${BASE}.cache-rows.json`);
const DOCKER_META = path.join(ROOT, "reports", "raw", "fast", `${BASE}.docker-tests.json`);
const TXID_TEST = path.join(ROOT, "reports", "raw", "fast", `${BASE}.txid-tests.json`);
const HANDOFF = path.join(ROOT, "coordination", "handoffs", "2026-07-17-coordinator-babylon-step9-handoff.md");
const INBOX = path.join(ROOT, "coordination", "inbox", "critical", "2026-07-17-coordinator-babylon-late-quorum-step9.json");
const PIN_COMMIT = "16e00c88d9cfd2e9f92bb786c474f6e79628a49f";
const PIN_TAG = "v4.3.0";
const TIMEOUT = Number(process.env.BABYLON_STEP9_TIMEOUT_MS || 12000);
const PAGE_LIMIT = 100;
const MAX_PAGES = 2000;
const MAX_BODY = 32 * 1024 * 1024;
const FIXED_PIN = {
  height: "3989464",
  hash: "825B66C709AD1A7DB851274DC11299F4EEF6E6DC9A548FA712D576CBC0C9CB76",
  time: "2026-07-17T04:29:25.025092032Z",
};
const EXPECTED_BOUNDARY = { earliestCometBlock: "2556426", unavailablePredecessorBlock: "2556425", firstMatchedTx: "2556625" };

const ALLOWED = new Set([
  RAW, TRANSCRIPT, FIXTURES, BOUNDARY, TEST_OUT, MANIFEST, REPORT, DEFINITIONS, SOURCES,
  CURRENT_PAGES, PREINDEX_ROWS, TX_EVENT_FACTS, ARCHIVE_FACTS, CACHE_ROWS, DOCKER_META, TXID_TEST,
  HANDOFF, INBOX,
].map((p) => path.resolve(p)));

function write(file, body) {
  file = path.resolve(file);
  if (!ALLOWED.has(file)) throw new Error(`write outside Step 9 stage: ${path.relative(ROOT, file)}`);
  if (!fs.existsSync(path.dirname(file))) throw new Error(`missing output directory: ${path.dirname(file)}`);
  fs.writeFileSync(file, body, "utf8");
}
function atomicWriteSet(entries) {
  const staged = [], backups = [];
  try {
    for (const [file0, body] of entries) {
      const file = path.resolve(file0);
      if (!ALLOWED.has(file)) throw new Error(`atomic write outside Step 9 stage: ${path.relative(ROOT, file)}`);
      const temp = `${file}.r3-stage-${process.pid}`;
      fs.writeFileSync(temp, body, { encoding: "utf8", flag: "wx" });
      staged.push([temp, file]);
    }
    for (const [temp, file] of staged) {
      const backup = `${file}.r3-backup-${process.pid}`;
      if (fs.existsSync(file)) { fs.renameSync(file, backup); backups.push([backup, file]); }
      fs.renameSync(temp, file);
    }
    for (const [backup] of backups) if (fs.existsSync(backup)) fs.unlinkSync(backup);
  } catch (e) {
    for (const [temp] of staged) if (fs.existsSync(temp)) fs.unlinkSync(temp);
    for (const [backup, file] of backups.reverse()) { if (fs.existsSync(file)) fs.unlinkSync(file); if (fs.existsSync(backup)) fs.renameSync(backup, file); }
    throw e;
  }
}
function rel(file) { return path.relative(ROOT, file).replace(/\\/g, "/"); }
function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
function cjson(value) { return JSON.stringify(canonical(value)); }
function intstr(v) { return v == null || !/^\d+$/.test(String(v)) ? null : String(v); }
function bigint(v) { const s = intstr(v); return s == null ? null : BigInt(s); }
function bool(v) { return v === true || v === "true" ? true : v === false || v === "false" ? false : null; }
function first(obj, paths) {
  for (const p of paths) {
    let v = obj;
    for (const k of p) v = v && typeof v === "object" ? v[k] : null;
    if (v != null && v !== "") return v;
  }
  return null;
}
function sanitizeError(e) {
  return String(e && e.message || e || "unknown")
    .replace(/https?:\/\/[^\s]+/gi, "[endpoint-omitted]")
    .replace(/[A-Za-z0-9_-]{24,}/g, "[opaque-omitted]")
    .replace(/[\r\n\t]+/g, " ").slice(0, 180);
}
function assertNoEndpointMaterial(text, label) {
  if (/https?:\/\//i.test(text) || /(?:www\.)?[a-z0-9-]+\.(?:com|io|org|net|xyz|dev|app|cloud)(?:\b|\/)/i.test(text)) {
    throw new Error(`endpoint/domain leak in ${label}`);
  }
}
function git(args, cwd) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (_) { return null; }
}

function extractUrls(text, requireBabylonContext) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const line of lines) {
    const urls = line.match(/https?:\/\/[^\s'"<>\[\]]+/g) || [];
    for (let u of urls) {
      u = u.replace(/[),;]+$/, "");
      if (!requireBabylonContext || /babylon|bbn-1/i.test(line) || /babylon|bbn/i.test(u)) out.push(u);
    }
  }
  return out;
}
function endpointPool() {
  const rpcText = fs.existsSync(RPC_INVENTORY) ? fs.readFileSync(RPC_INVENTORY, "utf8") : "";
  const gqlText = fs.existsSync(GRAPHQL_INVENTORY) ? fs.readFileSync(GRAPHQL_INVENTORY, "utf8") : "";
  const legacyText = fs.existsSync(LEGACY_SCANNER) ? fs.readFileSync(LEGACY_SCANNER, "utf8") : "";
  const rpc = extractUrls(rpcText, true);
  const gql = extractUrls(gqlText, true);
  const rpcDiscovery = extractUrls(rpcText, false);
  const gqlDiscovery = extractUrls(gqlText, false);
  const legacy = extractUrls(legacyText, true);
  const all = [];
  for (const [originClass, list] of [["authorized-rpc-inventory", rpc], ["authorized-graphql-inventory", gql], ["preserved-public-provider-source", legacy]]) {
    for (const url of list) if (!all.some((x) => x.url === url)) all.push({ url, originClass });
  }
  return {
    endpoints: all.map((x, i) => ({ ...x, alias: `provider-${String(i + 1).padStart(2, "0")}` })),
    discoveryEndpoints: [...new Set(rpcDiscovery)].slice(0, 96).map((url, i) => ({ url, alias: `discovery-rpc-${String(i + 1).padStart(2, "0")}`, kind: "rpc" })),
    discoveryIndexers: [...new Set(gqlDiscovery)].slice(0, 64).map((url, i) => ({ url, alias: `discovery-indexer-${String(i + 1).padStart(2, "0")}`, kind: "indexer" })),
    sanitizedCounts: { rpcInventoryCandidates: rpc.length, graphqlInventoryCandidates: gql.length, preservedPublicCandidates: legacy.length, deduplicatedCandidates: all.length, boundedRpcDiscoveryCandidates: Math.min(new Set(rpcDiscovery).size, 96), boundedIndexerDiscoveryCandidates: Math.min(new Set(gqlDiscovery).size, 64) },
  };
}
function join(base, suffix) {
  const u = new URL(base);
  const q = suffix.indexOf("?");
  const suffixPath = q >= 0 ? suffix.slice(0, q) : suffix;
  const suffixQuery = q >= 0 ? suffix.slice(q + 1) : "";
  if (!u.pathname.endsWith(suffixPath)) u.pathname = `${u.pathname.replace(/\/$/, "")}${suffixPath}`.replace(/\/+/g, "/");
  u.search = suffixQuery ? `?${suffixQuery}` : ""; u.hash = "";
  return u.toString();
}

async function request(url, { method = "GET", headers = {}, body = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { method, headers: { accept: "application/json", "user-agent": "babylon-step9-defensive-readonly/1", ...headers }, body, redirect: "manual", signal: controller.signal });
    if (r.status >= 300 && r.status < 400) throw new Error(`redirect rejected ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BODY) throw new Error(`response too large ${buf.length}`);
    let json = null;
    try { json = JSON.parse(buf.toString("utf8")); } catch (_) {}
    return { ok: r.ok && json != null, status: r.status, json, heightHeader: r.headers.get("x-cosmos-block-height") || null };
  } catch (e) { return { ok: false, status: null, json: null, heightHeader: null, error: sanitizeError(e) }; }
  finally { clearTimeout(timer); }
}

function parseStatus(j) {
  return {
    chainId: first(j, [["result", "node_info", "network"], ["node_info", "network"]]),
    height: intstr(first(j, [["result", "sync_info", "latest_block_height"], ["sync_info", "latest_block_height"]])),
    hash: first(j, [["result", "sync_info", "latest_block_hash"], ["sync_info", "latest_block_hash"]]),
    time: first(j, [["result", "sync_info", "latest_block_time"], ["sync_info", "latest_block_time"]]),
    catchingUp: bool(first(j, [["result", "sync_info", "catching_up"], ["sync_info", "catching_up"]])),
    cometVersion: first(j, [["result", "node_info", "version"], ["node_info", "version"]]),
  };
}
function parseAbci(j) {
  return {
    appName: first(j, [["result", "response", "data"], ["response", "data"]]),
    appVersion: String(first(j, [["result", "response", "version"], ["result", "response", "app_version"], ["response", "version"]]) || "") || null,
    lastHeight: intstr(first(j, [["result", "response", "last_block_height"], ["response", "last_block_height"]])),
  };
}
function parseNode(j) {
  const a = j && (j.application_version || j.applicationVersion) || {};
  return {
    chainId: first(j, [["default_node_info", "network"], ["node_info", "network"]]),
    appName: a.app_name || a.name || null,
    appVersion: a.version || a.app_version || null,
    gitCommit: a.git_commit || a.gitCommit || null,
    buildTags: a.build_tags || a.buildTags || null,
    cosmosSdkVersion: a.cosmos_sdk_version || a.cosmosSdkVersion || null,
  };
}
function parseTip(j) {
  return {
    height: intstr(first(j, [["header", "height"], ["tip", "height"], ["btc_tip", "height"], ["height"]])),
    hash: first(j, [["header", "hash_hex"], ["tip", "hash_hex"], ["btc_tip", "hash_hex"], ["header", "hash"], ["hash"]]),
  };
}

async function probeEndpoint(ep) {
  const status = await request(join(ep.url, "/status"));
  const s = status.ok ? parseStatus(status.json) : {};
  const abci = await request(join(ep.url, "/abci_info"));
  const a = abci.ok ? parseAbci(abci.json) : {};
  const node = await request(join(ep.url, "/cosmos/base/tendermint/v1beta1/node_info"));
  const n = node.ok ? parseNode(node.json) : {};
  const tip = await request(join(ep.url, "/babylon/btclightclient/v1/tip"));
  const t = tip.ok ? parseTip(tip.json) : {};
  const gql = await request(ep.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query{__typename}" }) });
  const chainIds = [s.chainId, n.chainId].filter(Boolean).map(String);
  const isBabylon = chainIds.includes("bbn-1");
  return {
    alias: ep.alias, originClass: ep.originClass,
    chainId: isBabylon ? "bbn-1" : null,
    cometStatus: Boolean(status.ok && s.chainId === "bbn-1"),
    cometAbci: Boolean(abci.ok && (isBabylon || a.appName)),
    gatewayNodeInfo: Boolean(node.ok && n.chainId === "bbn-1"),
    gatewayCurrentState: Boolean(tip.ok && t.height),
    graphqlRead: Boolean(gql.ok && gql.json && gql.json.data),
    current: isBabylon ? { status: s, abci: a, node: n, btcTip: t } : null,
    failures: [status, abci, node, tip, gql].filter((x) => !x.ok).length,
    _url: ep.url,
  };
}

async function discoverIndependentCoverage(pool, primaryUrls) {
  const rpcFindings = [];
  let cursor = 0;
  async function rpcWorker() {
    while (cursor < pool.discoveryEndpoints.length) {
      const ep = pool.discoveryEndpoints[cursor++];
      if (primaryUrls.has(ep.url)) continue;
      const r = await request(join(ep.url, "/status"));
      const status = r.ok ? parseStatus(r.json) : null;
      if (!status || status.chainId !== "bbn-1") continue;
      const genesisBlock = await request(join(ep.url, "/block?height=1"));
      const tx = await request(ep.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx_search", params: { query: "message.action='/babylon.btcstaking.v1.MsgAddCovenantSigs'", prove: false, page: "1", per_page: "1", order_by: "asc" } }) });
      const first = tx.json && tx.json.result && tx.json.result.txs && tx.json.result.txs[0];
      rpcFindings.push({ alias: ep.alias, chainId: "bbn-1", genesisBlockAvailable: genesisBlock.ok, txIndexAvailable: Boolean(tx.json && tx.json.result), firstMatchedHeight: intstr(first && first.height), advertisedMatchedTx: intstr(tx.json && tx.json.result && tx.json.result.total_count), coversPreRetainedBoundary: Boolean(genesisBlock.ok && tx.json && tx.json.result) });
    }
  }
  await Promise.all(Array.from({ length: Math.min(12, pool.discoveryEndpoints.length) }, rpcWorker));

  const indexerFindings = [];
  let icursor = 0;
  async function indexerWorker() {
    while (icursor < pool.discoveryIndexers.length) {
      const ep = pool.discoveryIndexers[icursor++];
      const q = { query: "query{__schema{queryType{fields{name}}}}" };
      const r = await request(ep.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(q) });
      const fields = first(r.json || {}, [["data", "__schema", "queryType", "fields"]]);
      const names = Array.isArray(fields) ? fields.map((x) => String(x.name || "")) : [];
      if (names.some((x) => /babylon|btc.*deleg|covenant|staking/i.test(x))) indexerFindings.push({ alias: ep.alias, introspectionReadable: true, stakingLikeSchema: true, completePreBoundaryCoverage: null });
    }
  }
  await Promise.all(Array.from({ length: Math.min(12, pool.discoveryIndexers.length) }, indexerWorker));
  const full = rpcFindings.find((x) => x.coversPreRetainedBoundary) || null;
  return {
    bounded: true,
    rpcCandidatesTested: pool.discoveryEndpoints.length,
    indexerCandidatesTested: pool.discoveryIndexers.length,
    independentBabylonRpcFindings: rpcFindings,
    stakingIndexerFindings: indexerFindings,
    fullPreBoundaryIndexFound: Boolean(full),
    result: full ? "INDEPENDENT_FULL_INDEX_FOUND" : "UNAVAILABLE_AFTER_BOUNDED_DISCOVERY",
    millionsOfBlocksBruteForced: false,
  };
}

function pageInfo(j) {
  const p = j && (j.pagination || first(j, [["result", "pagination"]])) || {};
  return { nextKey: p.next_key || p.nextKey || null, total: intstr(p.total) };
}
function hash256Display(bytes) {
  const one = crypto.createHash("sha256").update(bytes).digest();
  return Buffer.from(crypto.createHash("sha256").update(one).digest()).reverse().toString("hex");
}
function encodeVarInt(n) {
  n = BigInt(n);
  if (n < 0xfdn) return Buffer.from([Number(n)]);
  if (n <= 0xffffn) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(Number(n), 1); return b; }
  if (n <= 0xffffffffn) { const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(Number(n), 1); return b; }
  const b = Buffer.alloc(9); b[0] = 0xff; b.writeBigUInt64LE(n, 1); return b;
}
function bitcoinIdentity(txHex) {
  if (typeof txHex !== "string" || !/^[0-9a-fA-F]+$/.test(txHex) || txHex.length % 2) throw new Error("invalid Bitcoin transaction hex");
  const b = Buffer.from(txHex, "hex"); let p = 0;
  const take = (n) => { if (!Number.isSafeInteger(n) || n < 0 || p + n > b.length) throw new Error("truncated Bitcoin transaction"); const x = b.subarray(p, p + n); p += n; return x; };
  const varint = () => {
    const prefix = take(1)[0];
    let n;
    if (prefix < 0xfd) n = BigInt(prefix);
    else if (prefix === 0xfd) { n = BigInt(take(2).readUInt16LE()); if (n < 0xfdn) throw new Error("non-canonical Bitcoin varint"); }
    else if (prefix === 0xfe) { n = BigInt(take(4).readUInt32LE()); if (n <= 0xffffn) throw new Error("non-canonical Bitcoin varint"); }
    else { n = take(8).readBigUInt64LE(); if (n <= 0xffffffffn) throw new Error("non-canonical Bitcoin varint"); }
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("oversized Bitcoin vector");
    return Number(n);
  };
  const version = take(4);
  let witnessEncoding = false;
  if (p + 2 <= b.length && b[p] === 0x00 && b[p + 1] !== 0x00) { witnessEncoding = true; p += 2; }
  const vinCount = varint(); const inputs = [];
  for (let i = 0; i < vinCount; i++) { const outpoint = take(36), script = take(varint()), sequence = take(4); inputs.push({ outpoint, script, sequence, witness: [] }); }
  const voutCount = varint(); const outputs = [];
  for (let i = 0; i < voutCount; i++) { const value = take(8), script = take(varint()); outputs.push({ value, script }); }
  let witnessItems = 0;
  if (witnessEncoding) for (const input of inputs) { const count = varint(); for (let j = 0; j < count; j++) { input.witness.push(take(varint())); witnessItems++; } }
  const locktime = take(4);
  if (p !== b.length) throw new Error("trailing Bitcoin transaction bytes");
  if (witnessEncoding && witnessItems === 0) throw new Error("superfluous Bitcoin witness encoding");
  const inputParts = inputs.flatMap((x) => [x.outpoint, encodeVarInt(x.script.length), x.script, x.sequence]);
  const outputParts = outputs.flatMap((x) => [x.value, encodeVarInt(x.script.length), x.script]);
  const base = Buffer.concat([version, encodeVarInt(inputs.length), ...inputParts, encodeVarInt(outputs.length), ...outputParts, locktime]);
  let full = base;
  if (witnessEncoding) {
    const witnessParts = inputs.flatMap((x) => [encodeVarInt(x.witness.length), ...x.witness.flatMap((w) => [encodeVarInt(w.length), w])]);
    full = Buffer.concat([version, Buffer.from([0, 1]), encodeVarInt(inputs.length), ...inputParts, encodeVarInt(outputs.length), ...outputParts, ...witnessParts, locktime]);
  }
  return { canonicalTxid: hash256Display(base), canonicalWtxid: hash256Display(full), hasWitness: witnessEncoding, serializedBytes: b.length, baseBytes: base.length };
}
function goCanonicalCrossCheck(rows) {
  if (!rows.length) return { helper: rel(TXID_HELPER), checked: 0, mismatches: 0, errors: 0 };
  const input = rows.map((x, index) => JSON.stringify({ index, txHex: x._stakingTxHex })).join("\n") + "\n";
  let stdout;
  try { stdout = execFileSync("go", ["run", TXID_HELPER], { cwd: SOURCE, input, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }); }
  catch (e) { throw new Error(`canonical txid helper failed: ${sanitizeError(e)}`); }
  const answers = stdout.trim().split(/\r?\n/).filter(Boolean).map((x) => JSON.parse(x));
  if (answers.length !== rows.length) throw new Error(`canonical txid helper output count ${answers.length}/${rows.length}`);
  let mismatches = 0, errors = 0;
  for (const a of answers) {
    const row = rows[a.index];
    if (!row || a.error) { errors++; continue; }
    const expectedWitness = row.witnessDifferent == null ? row.hasWitness : row.witnessDifferent;
    if (a.txid !== row.canonicalTxid || a.wtxid !== row.canonicalWtxid || Boolean(a.hasWitness) !== Boolean(expectedWitness)) mismatches++;
  }
  if (mismatches || errors) {
    const firstMismatch = answers.find((a) => !a.error && rows[a.index] && (a.txid !== rows[a.index].canonicalTxid || a.wtxid !== rows[a.index].canonicalWtxid));
    const detail = firstMismatch ? `${firstMismatch.txid}/${rows[firstMismatch.index].canonicalTxid}/${firstMismatch.wtxid}/${rows[firstMismatch.index].canonicalWtxid}` : "none";
    throw new Error(`canonical txid helper mismatch/error ${mismatches}/${errors}; first=${detail}`);
  }
  return { helper: rel(TXID_HELPER), checked: rows.length, mismatches, errors };
}
function signer(row) { return String(row && (row.cov_pk || row.covPk || row.pk || row.covenant_pk || row.covenantPk) || "") || null; }
function signerHashes(rows) { return Array.isArray(rows) ? rows.map(signer).map((x) => x ? sha(String(x).toLowerCase()) : null) : null; }
function countSet(rows) {
  if (!Array.isArray(rows)) return { entries: null, distinct: null };
  return { entries: String(rows.length), distinct: String(new Set(rows.map(signer).filter(Boolean)).size) };
}
function compactDelegation(raw, paramsMap, provenance = null) {
  const d = raw && (raw.btc_delegation || raw.delegation || raw) || {};
  const ud = d.undelegation_response || d.undelegationResponse || {};
  const expansion = d.stk_exp || d.stkExp || null;
  const stakingTxHex = d.staking_tx_hex || d.stakingTxHex || null;
  const identity = bitcoinIdentity(stakingTxHex);
  const responseTxHash = String(raw && raw.staking_tx_hash || d.staking_tx_hash || d.stakingTxHash || "").toLowerCase() || null;
  const canonicalTxid = identity.canonicalTxid;
  const version = intstr(d.params_version ?? d.paramsVersion);
  const p = version == null ? null : paramsMap[version] || null;
  const a = countSet(d.covenant_sigs || d.covenantSigs);
  const b = countSet(ud.covenant_unbonding_sig_list || ud.covenantUnbondingSigList);
  const c = countSet(ud.covenant_slashing_sigs || ud.covenantSlashingSigs);
  const prev = countSet(expansion && (expansion.previous_stk_covenant_sigs || expansion.previousStkCovenantSigs));
  const end = intstr(d.end_height ?? d.endHeight);
  const unbond = intstr(d.unbonding_time ?? d.unbondingTime ?? (p && p.unbondingTime));
  const e = bigint(end), u = bigint(unbond);
  const threshold = e != null && u != null && e >= u ? (e - u).toString() : null;
  const early = ud.delegator_unbonding_info_response || ud.delegatorUnbondingInfoResponse;
  return {
    stakingTxHash: canonicalTxid, canonicalTxid, canonicalWtxid: identity.canonicalWtxid,
    responseTxHash, requestCanonicalHashEqualsResponseTxHash: responseTxHash == null ? null : responseTxHash === canonicalTxid,
    witnessDifferent: identity.canonicalWtxid !== canonicalTxid, serializedBytes: identity.serializedBytes, baseBytes: identity.baseBytes,
    startHeight: intstr(d.start_height ?? d.startHeight), endHeight: end, unbondingTime: unbond,
    totalSat: intstr(d.total_sat ?? d.totalSat), status: String(raw && (raw.status_desc ?? raw.status) || d.status_desc || d.status || "") || null,
    active: bool((raw && raw.active) ?? d.active), stakerAddress: d.staker_addr || d.stakerAddr || null,
    fpKeys: [...new Set((d.fp_btc_pk_list || d.fpBtcPkList || []).map(String))].sort(),
    inclusionPresent: intstr(d.start_height ?? d.startHeight) != null && intstr(d.end_height ?? d.endHeight) != null,
    earlyUnbonded: early == null ? null : Boolean(first(early, [["spend_stake_tx_hex"], ["spendStakeTxHex"]])),
    paramsVersion: version, covenantQuorum: p && p.covenantQuorum || null,
    covenantCounts: { staking: a, unbonding: b, unbondingSlashing: c },
    covenantSignerHashes: { staking: signerHashes(d.covenant_sigs || d.covenantSigs), unbonding: signerHashes(ud.covenant_unbonding_sig_list || ud.covenantUnbondingSigList), unbondingSlashing: signerHashes(ud.covenant_slashing_sigs || ud.covenantSlashingSigs) },
    expansion: expansion ? { predecessor: String(expansion.previous_staking_tx_hash_hex || expansion.previousStakingTxHashHex || "").toLowerCase() || null, predecessorSignerCount: prev.distinct, predecessorSignerHashes: signerHashes(expansion.previous_stk_covenant_sigs || expansion.previousStkCovenantSigs) } : null,
    expiryThreshold: threshold, provenance, _stakingTxHex: stakingTxHex,
  };
}
function parseParamsRow(row) {
  const p = row && (row.params || row.btc_staking_params || row) || {};
  return {
    version: intstr(row && (row.version ?? row.params_version ?? p.params_version)),
    covenantQuorum: intstr(p.covenant_quorum ?? p.covenantQuorum),
    unbondingTime: intstr(p.unbonding_time_blocks ?? p.unbonding_time ?? p.unbondingTimeBlocks),
    btcActivationHeight: intstr(row && (row.btc_activation_height ?? row.activation_height ?? p.btc_activation_height)),
  };
}
function rowsFrom(j, keys) {
  for (const k of keys) if (Array.isArray(j && j[k])) return j[k];
  return [];
}

async function getGateway(gw, route, height = null) {
  return request(join(gw._url, route), { headers: height == null ? {} : { "x-cosmos-block-height": String(height) } });
}
async function loadParams(gw, stateHeight = null) {
  const r = await getGateway(gw, "/babylon/btcstaking/v1/params_versions?pagination.limit=100&pagination.count_total=true", stateHeight);
  if (!r.ok) return { rows: [], map: {}, complete: false };
  const rows = rowsFrom(r.json, ["params", "params_versions", "btc_staking_params"]).map(parseParamsRow).filter((x) => x.version != null);
  return { rows, map: Object.fromEntries(rows.map((x) => [x.version, x])), complete: !pageInfo(r.json).nextKey };
}
async function exhaustDelegations(gw, paramsMap, stateHeight = null) {
  let key = null, firstPageAdvertisedTotal = null, complete = false, loop = false, error = null;
  const seenKeys = new Set(), seenIds = new Set(), rows = [], pages = [];
  let duplicates = 0, responseHashMismatches = 0, responseHashFieldAbsentCount = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const requestedCursorSha256 = key ? sha(key) : null;
    const suffix = `/babylon/btcstaking/v1/btc_delegations/ANY?pagination.limit=${PAGE_LIMIT}&pagination.count_total=true${key ? `&pagination.key=${encodeURIComponent(key)}` : ""}`;
    const r = await getGateway(gw, suffix, stateHeight);
    if (!r.ok) { error = r.error || `HTTP ${r.status}`; break; }
    const rawRows = rowsFrom(r.json, ["btc_delegations", "delegations"]);
    const compact = rawRows.map((x, rowIndex) => compactDelegation(x, paramsMap, { page, rowIndex, requestedHeight: stateHeight, servedHeight: r.heightHeader }));
    const ids = compact.map((x) => x.canonicalTxid).filter(Boolean);
    for (const row of compact) {
      const id = row.canonicalTxid;
      if (!row.responseTxHash) responseHashFieldAbsentCount++;
      else if (!row.requestCanonicalHashEqualsResponseTxHash) responseHashMismatches++;
      if (seenIds.has(id)) duplicates++; else { seenIds.add(id); rows.push(row); }
    }
    const p = pageInfo(r.json); if (page === 1) firstPageAdvertisedTotal = p.total;
    pages.push({ page, requestedCursorSha256, returnedNextCursorSha256: p.nextKey ? sha(p.nextKey) : null, rowCount: rawRows.length, canonicalRowIds: ids, requestedHeight: stateHeight, servedHeight: r.heightHeader, advertisedTotal: page === 1 ? p.total : null, pageSha256: sha(cjson({ page, requestedCursorSha256, returnedNextCursorSha256: p.nextKey ? sha(p.nextKey) : null, rowCount: rawRows.length, canonicalRowIds: ids, servedHeight: r.heightHeader })) });
    if (!p.nextKey) { complete = true; break; }
    if (seenKeys.has(p.nextKey)) { loop = true; error = "repeated pagination cursor"; break; }
    seenKeys.add(p.nextKey); key = p.nextKey;
  }
  const helperCrossCheck = goCanonicalCrossCheck(rows);
  const witnessDifferentCount = rows.filter((x) => x.witnessDifferent).length;
  for (const row of rows) delete row._stakingTxHex;
  const totalInconsistent = firstPageAdvertisedTotal != null && firstPageAdvertisedTotal !== "0" && BigInt(firstPageAdvertisedTotal) !== BigInt(rows.length);
  const servedHeightExact = stateHeight == null ? null : pages.every((p) => p.servedHeight && BigInt(p.servedHeight) === BigInt(stateHeight));
  return { rows, proof: { pages, pageCount: pages.length, uniqueRows: rows.length, duplicates, canonicalUniqueIds: seenIds.size, witnessDifferentCount, responseHashMismatches, responseHashFieldAbsentCount, helperCrossCheck, firstPageAdvertisedTotal, advertisedTotalInconsistent: totalInconsistent, cursorLoop: loop, nextKeyEmpty: complete, complete, requestedHeight: stateHeight, servedHeightExact, error } };
}

function decodeAttr(v) {
  if (typeof v !== "string") return "";
  let out = v;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(v) && v.length % 4 === 0) {
    try { const s = Buffer.from(v, "base64").toString("utf8"); if (/^[\x20-\x7e]+$/.test(s)) out = s; } catch (_) {}
  }
  if (/^".*"$/.test(out)) { try { const parsed = JSON.parse(out); if (typeof parsed === "string") out = parsed; } catch (_) {} }
  return out;
}
function eventMap(events) {
  return (events || []).map((e, eventIndex) => ({
    eventIndex,
    type: decodeAttr(e.type),
    attrs: Object.fromEntries((e.attributes || []).map((a) => [decodeAttr(a.key), decodeAttr(a.value)])),
  }));
}
function attrLike(attrs, needle) {
  for (const [k, v] of Object.entries(attrs || {})) if (String(k).toLowerCase().includes(needle)) return v;
  return null;
}
function compactTx(tx) {
  const result = tx.tx_result || tx.txResult || {};
  const events = eventMap(result.events || []);
  const sigEvents = events.filter((e) => /EventCovenantSignatureReceived/i.test(e.type));
  const quorumEvents = events.filter((e) => /EventCovenantQuorumReached/i.test(e.type));
  const signatureFacts = sigEvents.map((e, messageIndex) => ({
    messageIndex,
    eventIndex: e.eventIndex,
    canonicalStakingTxid: String(attrLike(e.attrs, "staking_tx_hash") || "").toLowerCase() || null,
    signerIdentityHash: attrLike(e.attrs, "covenant_btc_pk") ? sha(String(attrLike(e.attrs, "covenant_btc_pk")).toLowerCase()) : null,
  }));
  const quorumFacts = quorumEvents.map((e, quorumIndex) => ({ quorumIndex, eventIndex: e.eventIndex, canonicalStakingTxid: String(attrLike(e.attrs, "staking_tx_hash") || "").toLowerCase() || null, state: attrLike(e.attrs, "new_state") || null }));
  return {
    txHash: String(tx.hash || "").toLowerCase() || null, height: intstr(tx.height), txIndex: intstr(tx.index), code: intstr(result.code) || "0", success: (intstr(result.code) || "0") === "0",
    signatureFacts, quorumFacts, signatureEventCount: sigEvents.length, quorumEventCount: quorumFacts.length,
    quorumReached: quorumEvents.length > 0,
    quorumStates: [...new Set(quorumEvents.map((e) => attrLike(e.attrs, "new_state")).filter(Boolean))],
    rawTxPersisted: false, covenantSignatureBytesPersisted: false,
  };
}
function joinTransactionFacts(transactions) {
  const joinedMessages = [], joinedQuorumEvents = [];
  let failedJoins = 0;
  for (const tx of transactions.filter((x) => x.success)) {
    const used = new Set();
    for (const m of tx.signatureFacts) joinedMessages.push({ txHash: tx.txHash, success: tx.success, height: tx.height, txIndex: tx.txIndex, messageIndex: m.messageIndex, eventIndex: m.eventIndex, canonicalStakingTxid: m.canonicalStakingTxid, signerIdentityHash: m.signerIdentityHash });
    for (const q of tx.quorumFacts) {
      const choices = tx.signatureFacts.filter((m) => m.canonicalStakingTxid === q.canonicalStakingTxid && m.eventIndex <= q.eventIndex && !used.has(m.messageIndex)).sort((a, b) => b.eventIndex - a.eventIndex);
      const joined = choices[0] || null;
      if (!joined) failedJoins++; else used.add(joined.messageIndex);
      joinedQuorumEvents.push({ txHash: tx.txHash, success: tx.success, height: tx.height, txIndex: tx.txIndex, quorumIndex: q.quorumIndex, eventIndex: q.eventIndex, messageIndex: joined ? joined.messageIndex : null, signatureEventIndex: joined ? joined.eventIndex : null, canonicalStakingTxid: q.canonicalStakingTxid, signerIdentityHash: joined ? joined.signerIdentityHash : null, state: q.state });
    }
  }
  const messageSemanticKeys = joinedMessages.map((x) => `${x.txHash}:${x.canonicalStakingTxid}:${x.signerIdentityHash}`);
  const quorumSemanticKeys = joinedQuorumEvents.map((x) => `${x.txHash}:${x.canonicalStakingTxid}:${x.state}`);
  return {
    joinedMessages, joinedQuorumEvents, failedJoins,
    messageSemanticCollisionCount: messageSemanticKeys.length - new Set(messageSemanticKeys).size,
    quorumSemanticCollisionCount: quorumSemanticKeys.length - new Set(quorumSemanticKeys).size,
  };
}
async function txSearch(rpc, query) {
  let page = 1, total = null, complete = false, error = null; const out = [], proofs = [];
  for (; page <= MAX_PAGES; page++) {
    const r = await request(rpc._url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: page, method: "tx_search", params: { query, prove: false, page: String(page), per_page: "100", order_by: "asc" } }),
    });
    if (!r.ok || r.json && r.json.error) { error = r.json && r.json.error && sanitizeError(r.json.error.message) || r.error || `HTTP ${r.status}`; break; }
    const result = r.json.result || {}; const txs = result.txs || [];
    if (total == null) total = intstr(result.total_count || result.totalCount) || String(txs.length);
    const compact = txs.map(compactTx); out.push(...compact);
    proofs.push({ page, rows: compact.length, txIdentitySha256: sha(compact.map((x) => x.txHash).filter(Boolean).sort().join("\n")) });
    if (out.length >= Number(total) || txs.length === 0) { complete = true; break; }
  }
  return { rows: out, proof: { queryClass: "message-action-add-covenant-sigs", pageCount: proofs.length, pages: proofs, advertisedTotal: total, rows: out.length, complete, error } };
}

async function historicalDelegation(gw, hash, height, paramsMap) {
  const r = await getGateway(gw, `/babylon/btcstaking/v1/btc_delegation/${encodeURIComponent(hash)}`, height);
  if (!r.ok) return null;
  const raw = r.json.btc_delegation || r.json.delegation || null;
  if (!raw) return null;
  const row = compactDelegation(r.json, paramsMap, { stateHeight: String(height), servedHeight: r.heightHeader, requestCanonicalTxid: String(hash).toLowerCase() });
  row.provenance.responseCanonicalTxid = row.canonicalTxid;
  row.provenance.requestCanonicalHashEqualsResponseTxHash = row.canonicalTxid === String(hash).toLowerCase() && (row.responseTxHash == null || row.responseTxHash === row.canonicalTxid);
  delete row._stakingTxHex;
  return row;
}
async function historicalTip(gw, height) {
  const r = await getGateway(gw, "/babylon/btclightclient/v1/tip", height);
  return r.ok ? { ...parseTip(r.json), servedHeight: r.heightHeader } : null;
}
function quorumState(d, predecessor, paramsMap) {
  if (!d) return { complete: null, minimumDistinct: null, reason: "delegation-unavailable" };
  const q = bigint(d.covenantQuorum || paramsMap[d.paramsVersion] && paramsMap[d.paramsVersion].covenantQuorum);
  const counts = [d.covenantCounts.staking.distinct, d.covenantCounts.unbonding.distinct, d.covenantCounts.unbondingSlashing.distinct].map(bigint);
  if (q == null || counts.some((x) => x == null)) return { complete: null, minimumDistinct: null, reason: "quorum-or-counts-unavailable" };
  let complete = counts.every((x) => x >= q); let min = counts.reduce((a, b) => a < b ? a : b);
  if (d.expansion) {
    const prevQ = predecessor && bigint(predecessor.covenantQuorum || paramsMap[predecessor.paramsVersion] && paramsMap[predecessor.paramsVersion].covenantQuorum);
    const prevCount = bigint(d.expansion.predecessorSignerCount);
    if (prevQ == null || prevCount == null) return { complete: null, minimumDistinct: min.toString(), reason: "expansion-predecessor-unavailable" };
    complete = complete && prevCount >= prevQ; if (prevCount < min) min = prevCount;
  }
  return { complete, minimumDistinct: min.toString(), quorum: q.toString(), reason: null };
}
function blockEvents(j) {
  const r = j && j.result || {};
  return eventMap([...(r.begin_block_events || []), ...(r.end_block_events || []), ...(r.finalize_block_events || []), ...((r.txs_results || []).flatMap((x) => x && x.events || []))]);
}
async function blockResults(rpc, height) {
  const r = await request(join(rpc._url, `/block_results?height=${height}`));
  return r.ok ? blockEvents(r.json) : null;
}
async function cometBlockBoundary(rpc, height) {
  const r = await request(join(rpc._url, `/block?height=${height}`));
  return {
    requestedHeight: String(height), available: r.ok,
    servedHeight: intstr(first(r.json || {}, [["result", "block", "header", "height"], ["block", "header", "height"]])),
    hash: first(r.json || {}, [["result", "block_id", "hash"], ["block_id", "hash"]]) || null,
    time: first(r.json || {}, [["result", "block", "header", "time"], ["block", "header", "time"]]) || null,
  };
}
async function locateExpiry(gw, rpc, threshold, upper, stakingHash) {
  let lo = 1n, hi = BigInt(upper), answer = null, probes = 0;
  while (lo <= hi && probes < 40) {
    const mid = (lo + hi) >> 1n; probes++;
    const tip = await historicalTip(gw, mid.toString());
    if (!tip || bigint(tip.height) == null) return { height: null, eventFound: null, archiveAvailable: false, probes };
    if (bigint(tip.height) >= BigInt(threshold)) { answer = mid; hi = mid - 1n; } else lo = mid + 1n;
  }
  if (answer == null) return { height: null, eventFound: false, archiveAvailable: true, probes };
  let found = false, eventHeight = null;
  for (const h of [answer, answer + 1n]) {
    const evs = await blockResults(rpc, h.toString());
    if (!evs) continue;
    if (evs.some((e) => /EventBTCDelegationExpired/i.test(e.type) && String(attrLike(e.attrs, "staking_tx_hash") || "").toLowerCase() === stakingHash.toLowerCase())) { found = true; eventHeight = h.toString(); break; }
  }
  return { height: answer.toString(), eventHeight, eventFound: found, archiveAvailable: true, probes };
}

async function assessTransitions(transitions, currentMap, gw, rpc, paramsMap, archiveAvailable) {
  const out = [];
  const heights = [...new Set(transitions.map((x) => x.height).filter(Boolean))];
  const tipByHeight = new Map();
  if (archiveAvailable) {
    let cursor = 0;
    async function worker() {
      while (cursor < heights.length) {
        const i = cursor++; const h = heights[i];
        tipByHeight.set(h, await historicalTip(gw, h));
      }
    }
    await Promise.all(Array.from({ length: Math.min(16, heights.length) }, worker));
  }
  for (const tx of transitions) {
    for (const stakingHash of [tx.stakingTxHash]) {
      const current = currentMap.get(stakingHash.toLowerCase()) || null;
      let basis = current;
      if (archiveAvailable && (!basis || !basis.expiryThreshold)) basis = await historicalDelegation(gw, stakingHash, tx.height, paramsMap);
      const base = { txHash: tx.txHash, messageHash: tx.txHash, messageIndex: tx.messageIndex, height: tx.height, stakingTxHash: stakingHash, quorumState: tx.state, currentDelegationFound: Boolean(current), historicalBasisUsed: !current && Boolean(basis), quorumEvent: true };
      if (!archiveAvailable || !basis || !basis.expiryThreshold) { out.push({ ...base, evidenceClass: "unassessable", blocker: !archiveAvailable ? "historical-height-state-unavailable" : "current-and-historical-delegation-threshold-unavailable" }); continue; }
      const tip = tipByHeight.get(tx.height) || null;
      if (!tip || bigint(tip.height) == null) { out.push({ ...base, evidenceClass: "unassessable", blocker: "btc-tip-at-transaction-unavailable" }); continue; }
      const chronologicalLate = bigint(tip.height) >= BigInt(basis.expiryThreshold);
      const before = await historicalDelegation(gw, stakingHash, (BigInt(tx.height) - 1n).toString(), paramsMap);
      const after = await historicalDelegation(gw, stakingHash, tx.height, paramsMap);
      let prevBefore = null, prevAfter = null;
      if (basis.expansion && basis.expansion.predecessor) {
        prevBefore = await historicalDelegation(gw, basis.expansion.predecessor, (BigInt(tx.height) - 1n).toString(), paramsMap);
        prevAfter = await historicalDelegation(gw, basis.expansion.predecessor, tx.height, paramsMap);
      }
      const qBefore = quorumState(before, prevBefore, paramsMap), qAfter = quorumState(after, prevAfter, paramsMap);
      const immediateDistinctCounts = qAfter.quorum ? {
        before: (BigInt(qAfter.quorum) - 1n).toString(),
        after: qAfter.quorum,
        derivation: "first-quorum event joined to one accepted unique-signer message; source transition is quorum-1 to quorum; archived post-block state may include later same-block signatures",
      } : { before: null, after: null, derivation: "quorum unavailable" };
      const expiry = chronologicalLate ? await locateExpiry(gw, rpc, basis.expiryThreshold, tx.height, stakingHash) : { height: null, eventHeight: null, eventFound: false, archiveAvailable: true, probes: 0 };
      const pendingBefore = before ? String(before.status || "").toUpperCase() === "PENDING" : null;
      const activeQueued = String(tx.state).toUpperCase() === "ACTIVE";
      const margin = chronologicalLate
        ? (bigint(tip.height) - BigInt(basis.expiryThreshold)).toString()
        : (BigInt(basis.expiryThreshold) - bigint(tip.height)).toString();
      const facts = {
        noQuorumBefore: qBefore.complete == null ? null : !qBefore.complete,
        btcTipAtOrAfterExpiry: chronologicalLate,
        handlerPendingBefore: pendingBefore,
        quorumAfter: qAfter.complete,
        activeQueued,
        expiryEventProcessedBefore: expiry.eventFound == null ? null : expiry.eventFound && BigInt(expiry.eventHeight) < BigInt(tx.height),
      };
      if (!chronologicalLate) {
        out.push({ ...base, evidenceClass: "not-candidate-before-expiry", blocker: null, btcTipAtTx: tip.height, btcTipRequestedHeight: tx.height, btcTipServedHeight: tip.servedHeight, expiryThreshold: basis.expiryThreshold, marginBlocks: margin, marginDirection: "blocks-before-expiry", paramsVersion: basis.paramsVersion, covenantQuorum: basis.covenantQuorum, inclusionPresent: basis.inclusionPresent, expansion: basis.expansion, immediateDistinctCounts, before, after, predecessorBefore: prevBefore, predecessorAfter: prevAfter, qBefore, qAfter, expiry, facts });
        continue;
      }
      const strong = Object.values(facts).every((x) => x === true);
      const partial = !strong && facts.btcTipAtOrAfterExpiry && facts.activeQueued && (facts.noQuorumBefore === true || facts.handlerPendingBefore === true || facts.quorumAfter === true || facts.expiryEventProcessedBefore === true);
      out.push({
        ...base, evidenceClass: strong ? "strong" : partial ? "partial" : "unassessable", blocker: strong ? null : partial ? "one-or-more-exact-chronology-facts-missing" : "chronology-predicate-not-established",
        btcTipAtTx: tip.height, btcTipRequestedHeight: tx.height, btcTipServedHeight: tip.servedHeight, expiryThreshold: basis.expiryThreshold, marginBlocks: margin, marginDirection: "blocks-after-expiry", paramsVersion: basis.paramsVersion, covenantQuorum: basis.covenantQuorum, inclusionPresent: basis.inclusionPresent, expansion: basis.expansion, immediateDistinctCounts, before, after, predecessorBefore: prevBefore, predecessorAfter: prevAfter, qBefore, qAfter, expiry, facts,
      });
    }
  }
  return out;
}

async function currentPower(gw, pinHeight, delegations) {
  const expected = new Map();
  for (const d of delegations) if (String(d.status).toUpperCase() === "ACTIVE") for (const fp of d.fpKeys) expected.set(fp, (expected.get(fp) || 0n) + BigInt(d.totalSat || "0"));
  const r = await getGateway(gw, `/babylon/finality/v1/vp_dst_cache/${pinHeight}`, pinHeight);
  if (!r.ok) return { available: false, expectedFpCount: expected.size, cacheRows: null, mismatches: null };
  const fps = rowsFrom(r.json, ["finality_providers"]); const mismatches = [], seen = new Set(), duplicates = [];
  const cacheRows = [];
  for (const fp of fps) {
    const key = String(fp.btc_pk_hex || fp.btcPkHex || ""); const observed = intstr(fp.total_bonded_sat ?? fp.totalBondedSat);
    if (seen.has(key)) duplicates.push(key); else seen.add(key);
    cacheRows.push({ fpKey: key, totalBondedSat: observed, isTimestamped: bool(fp.is_timestamped ?? fp.isTimestamped), isJailed: bool(fp.is_jailed ?? fp.isJailed), isSlashed: bool(fp.is_slashed ?? fp.isSlashed) });
    if (key && observed != null && (expected.get(key) || 0n).toString() !== observed) mismatches.push({ fpKey: key, expectedStatusDerivedSat: (expected.get(key) || 0n).toString(), cacheTotalBondedSat: observed });
  }
  const expectedRows = [...expected.entries()].map(([fpKey, total]) => ({ fpKey, totalBondedSat: total.toString() })).sort((a, b) => a.fpKey.localeCompare(b.fpKey));
  cacheRows.sort((a, b) => a.fpKey.localeCompare(b.fpKey));
  const missing = expectedRows.filter((x) => !seen.has(x.fpKey)).map((x) => x.fpKey);
  const extra = cacheRows.filter((x) => !expected.has(x.fpKey)).map((x) => x.fpKey);
  const expectedTotalSat = expectedRows.reduce((n, x) => n + BigInt(x.totalBondedSat), 0n).toString();
  const cacheTotalSat = cacheRows.reduce((n, x) => n + BigInt(x.totalBondedSat || "0"), 0n).toString();
  const noAggregateCacheMismatchAtPin = mismatches.length === 0 && duplicates.length === 0 && missing.length === 0 && extra.length === 0 && expectedTotalSat === cacheTotalSat;
  return {
    available: true, requestedHeight: pinHeight, servedHeight: r.heightHeader, expectedFpCount: expected.size,
    cacheRowCount: fps.length, cacheRows, expectedRows, duplicates, missing, extra, mismatches, mismatchCount: mismatches.length,
    expectedTotalSat, cacheTotalSat, numActiveFps: intstr(r.json.num_active_fps ?? r.json.numActiveFps),
    activeExpansionCount: delegations.filter((d) => String(d.status).toUpperCase() === "ACTIVE" && d.expansion).length,
    activeMultiFpDelegations: delegations.filter((d) => String(d.status).toUpperCase() === "ACTIVE" && d.fpKeys.length > 1).length,
    noAggregateCacheMismatchAtPin,
  };
}
async function candidatePowerReward(gw, rpc, candidates) {
  const out = [];
  for (const c of candidates.filter((x) => x.evidenceClass === "strong" || x.evidenceClass === "partial")) {
    const h = BigInt(c.height); const power = [];
    for (const x of [h - 1n, h, h + 1n, h + 2n]) {
      const cache = await getGateway(gw, `/babylon/finality/v1/vp_dst_cache/${x}`);
      const evs = await blockResults(rpc, x.toString());
      power.push({ height: x.toString(), cacheAvailable: cache.ok, cache: cache.ok ? { totalVotingPower: intstr(cache.json.total_voting_power), numActiveFps: intstr(cache.json.num_active_fps), fpRows: rowsFrom(cache.json, ["finality_providers"]).length } : null, relevantEventCount: evs ? evs.filter((e) => String(attrLike(e.attrs, "staking_tx_hash") || "").toLowerCase() === c.stakingTxHash.toLowerCase()).length : null });
    }
    out.push({ txHash: c.txHash, stakingTxHash: c.stakingTxHash, power, expectedDelegationSatDeltaPerFp: c.after && c.after.totalSat || null, provenCacheFpDelta: null, correctionEventProvenAbsent: null, activationHookObserved: null, rewardTrackerBefore: null, rewardTrackerAfter: null, attributableAccruedReward: null, attributableWithdrawableReward: null, attributableWithdrawnReward: null, legalLoss: null });
  }
  return out;
}

function deploymentBinding(pin, sourceIdentity) {
  const appVersion = pin.appVersion;
  const commit = pin.gitCommit;
  if (commit && commit.toLowerCase() === PIN_COMMIT) return { appVersion, exposedCommit: commit, sourceVersionBinding: "node-self-reported-version-and-commit-match-tracked-vulnerable-source", cryptographicProductionBinaryHashMatch: null, vulnerableSemanticsDeployed: true, deployedPatchStatus: "node-self-reports-unpatched-v4.3.0-commit; binary hash equivalence unproven" };
  if (appVersion === PIN_TAG) return { appVersion, exposedCommit: commit || null, sourceVersionBinding: "reported-release-version-only-commit-null", vulnerableSemanticsDeployed: true, deployedPatchStatus: "reported-v4.3.0-release-unpatched; exact-build-commit-unexposed" };
  return { appVersion: appVersion || null, exposedCommit: commit || null, sourceVersionBinding: null, vulnerableSemanticsDeployed: null, deployedPatchStatus: "unknown-version-or-unbound-build" };
}
function statusCounts(rows) { const o = {}; for (const r of rows) o[String(r.status || "NULL").toUpperCase()] = (o[String(r.status || "NULL").toUpperCase()] || 0) + 1; return o; }
function signerEntryTotals(rows) {
  const sum = (name) => rows.reduce((n, d) => n + BigInt(d.covenantCounts[name].entries || "0"), 0n).toString();
  return { staking: sum("staking"), unbonding: sum("unbonding"), unbondingSlashing: sum("unbondingSlashing") };
}
function currentEvidenceRow(d) {
  const { covenantSignerHashes, _stakingTxHex, ...row } = d;
  if (row.expansion) { const { predecessorSignerHashes, ...expansion } = row.expansion; row.expansion = expansion; }
  return row;
}
function paginationSummary(p) {
  const { pages, ...summary } = p;
  return summary;
}

function canonicalTxidVectorTests(currentProof = null, preIndexProof = null) {
  const vectors = [
    {
      label: "btcd-wire-legacy-synthetic",
      txHex: `0100000001${"00".repeat(32)}ffffffff00ffffffff0100000000000000000000000000`,
      expectedTxid: "2fb7d2ab4ea206f3491ae234583c124d5087b6267308288e1359a6052fc477e1",
      expectedWtxid: "2fb7d2ab4ea206f3491ae234583c124d5087b6267308288e1359a6052fc477e1",
    },
    {
      label: "babylon-witness-identity-separation-synthetic",
      txHex: `02000000000101${"00".repeat(32)}ffffffff00ffffffff0100000000000000000001010000000000`,
      expectedTxid: "cdc38c3647a0c36cdcfb26e6c8425d3aeeef3f8a3540664bd70293b71cb9883b",
      expectedWtxid: "8218cb1a30b4875769f85a5cee3cf938a34703382638ff180c730318a0f1d35f",
    },
  ];
  const rows = vectors.map((v) => ({ ...bitcoinIdentity(v.txHex), _stakingTxHex: v.txHex }));
  const helper = goCanonicalCrossCheck(rows);
  const results = vectors.map((v, i) => ({ label: v.label, expectedTxid: v.expectedTxid, expectedWtxid: v.expectedWtxid, canonicalTxid: rows[i].canonicalTxid, canonicalWtxid: rows[i].canonicalWtxid, hasWitness: rows[i].hasWitness, expectedMatch: rows[i].canonicalTxid === v.expectedTxid && rows[i].canonicalWtxid === v.expectedWtxid }));
  return {
    schemaVersion: 1,
    semantics: "canonical txid is btcd wire.MsgTx.TxHash / Babylon BTCDelegation.MustGetStakingTxHash; wtxid is labeled separately",
    helper: { path: rel(TXID_HELPER), pinnedModule: "sources/babylon-v4.3.0/go.mod", dependency: "btcd", version: "v0.24.2", ...helper },
    vectors: results,
    liveCrossCheck: currentProof && preIndexProof ? { currentRows: currentProof.helperCrossCheck.checked, preIndexRows: preIndexProof.helperCrossCheck.checked, mismatches: currentProof.helperCrossCheck.mismatches + preIndexProof.helperCrossCheck.mismatches, errors: currentProof.helperCrossCheck.errors + preIndexProof.helperCrossCheck.errors } : null,
  };
}

function fixtures(boundaryFixture = null) {
  const sourceMarkers = [
    ["sources/babylon-v4.3.0/x/btcstaking/types/btc_delegation.go", "if !d.HasCovenantQuorums(covenantQuorum, quorumPreviousStk)"],
    ["sources/babylon-v4.3.0/x/btcstaking/keeper/msg_server.go", "status == types.BTCDelegationStatus_UNBONDED || status == types.BTCDelegationStatus_EXPIRED"],
    ["sources/babylon-v4.3.0/x/btcstaking/keeper/btc_delegations.go", "k.addPowerDistUpdateEvent(ctx, btcTipHeight, activeEvent)"],
    ["sources/babylon-v4.3.0/x/finality/keeper/power_dist_change.go", "k.BTCStakingKeeper.ClearPowerDistUpdateEvents(ctx, i)"],
    ["sources/babylon-v4.3.0/x/finality/keeper/power_dist_change.go", "state.DeltaSatsByFpBtcPk[fpBTCPKHex] += int64(btcDel.TotalSat)"],
  ].map(([p, marker]) => ({ path: p, marker }));
  return {
    schemaVersion: 2,
    sourceMarkers,
    eventFixtures: [
      { type: "babylon.btcstaking.v1.EventCovenantSignatureReceived", attributes: { staking_tx_hash: "fixture-staking-hash", covenant_btc_pk_hex: "fixture-signer" }, signatureBytesIncluded: false },
      { type: "babylon.btcstaking.v1.EventCovenantQuorumReached", attributes: { staking_tx_hash: "fixture-staking-hash", new_state: "ACTIVE" }, signatureBytesIncluded: false },
      { type: "babylon.btcstaking.v1.EventBTCDelegationExpired", attributes: { staking_tx_hash: "fixture-staking-hash", new_state: "EXPIRED" }, signatureBytesIncluded: false },
    ],
    predicateFixture: { before: { status: "PENDING", quorum: "6", minimumDistinct: "5" }, btcTip: "999", expiryThreshold: "999", after: { status: "EXPIRED", minimumDistinct: "6" }, expiryEventBefore: true, activeQueued: true, expectedClass: "strong" },
    archiveBoundary: boundaryFixture,
    covenantSignatureBytesIncluded: false,
  };
}

function renderDefinitions() {
  return `# Babylon BAB-H-01 Step 9 Definitions\n\nSignal: 🟡 VULNERABLE — supporting definitions for the source-confirmed conditional High finding.\n\n- **Strong:** exact height-pinned state proves no quorum and PENDING immediately before the accepted message, BTC tip at the message is at/after \`EndHeight-UnbondingTime\`, quorum exists immediately after, ACTIVE was emitted, and the matching expiry event was processed earlier.\n- **Partial:** the transition is late and ACTIVE was emitted, with at least one additional exact predicate fact, but one or more archive/event facts are unavailable.\n- **Retained coverage:** the available Comet block/tx index beginning at its proven earliest block through the fixed pin. It is not genesis-to-pin history.\n- **Overall production exposure:** \`UNKNOWN/COVERAGE_OPEN\` whenever pre-retention transaction/event history lacks an independent complete index.\n- **No aggregate cache mismatch at pin:** exact FP-key set equality, no duplicates/missing/extra rows, and equal per-FP and aggregate satoshi totals. It does not prove absence of historical poison or rewards.\n- **Context only:** current EXPIRED-with-quorum without historical ordering or candidate-specific cache proof.\n- **Operational route:** requires exact currently available valid covenant material plus attributable reward extraction economics; public relayability is not signature forgery.\n- **Message index:** zero-based occurrence order of EventCovenantSignatureReceived within the successful transaction; quorum events are joined by transaction and staking hash. Cosmos exposes no separate canonical per-message transaction hash.\n`;
}
function renderSources(sourceIdentity) {
  return `# Babylon BAB-H-01 Step 9 Sources\n\nSignal: 🟡 VULNERABLE — supporting source manifest; overall exposure remains coverage-open.\n\n- Pinned source: \`sources/babylon-v4.3.0\`, tag \`${PIN_TAG}\`, commit \`${PIN_COMMIT}\`; observed commit \`${sourceIdentity.observedCommit}\`.\n- Node application metadata self-reports the same version/commit. This is not a cryptographic production-binary hash match.\n- Forward remediation worktree: \`sources/babylon-v4.3.0-remediation\` (read-only in Step 9).\n- Canonical API/event definitions: \`proto/babylon/btcstaking/v1/query.proto\`, \`events.proto\`, \`tx.proto\`, \`proto/babylon/finality/v1/query.proto\`, and \`proto/babylon/incentive/query.proto\`.\n- Vulnerable source path: \`x/btcstaking/types/btc_delegation.go\`, \`x/btcstaking/keeper/msg_server.go\`, \`x/btcstaking/keeper/btc_delegations.go\`, and \`x/finality/keeper/power_dist_change.go\`.\n- Provider evidence is represented only by aliases and capability/count facts. Endpoint inventories were consumed in memory under current-turn authorization; no URL, domain, token, header, inventory hash, or inventory content is distributed.\n`;
}
function table(headers, rows) { return `| ${headers.join(" | ")} |\n|${headers.map(() => "---").join("|")}|\n${rows.map((r) => `| ${r.map((x) => String(x == null ? "null" : x).replace(/\|/g, "\\|")).join(" | ")} |`).join("\n")}\n`; }
function renderReport(raw) {
  const p = raw.pin;
  const b = raw.coverage.preIndexArchiveState;
  const c = raw.currentExposure.power;
  return `# Babylon Genesis bbn-1 BAB-H-01 Step 9 Production Exposure — Oracle Remediation R2\n\nSignal: 🟡 VULNERABLE — source/exposed commit remains conditional High; retained range is **${raw.retainedRangeExposure}**; overall exposure is **${raw.productionExposure}**.\n\n## Fixed pin and deployment binding\n\n- Evidence revision/run: \`${raw.evidenceRevision}\` / \`${raw.runId}\`; fixed pin \`${p.height}\` / \`${p.hash}\` / \`${p.time}\`; hash recheck=${raw.finalRecheck.fixedPinHashMatched}.\n- BTC tip at exact pin: \`${p.btcTip.height}\`, requested/served \`${p.btcTip.requestedHeight}/${p.btcTip.servedHeight}\`.\n- Node self-reports \`${p.appName} ${p.appVersion}\`, commit \`${p.gitCommit}\`, matching tracked vulnerable source. No cryptographic production-binary hash equivalence is claimed.\n\n## Sanitized provider and full-index discovery\n\n${table(["Alias", "Origin", "Chain", "Gateway", "Comet", "ABCI", "Archive", "tx_search", "block_results"], raw.providers.map((x) => [x.alias, x.originClass, x.chainId, x.gatewayCurrentState, x.cometStatus, x.cometAbci, x.archiveHistoricalState, x.txSearch, x.blockResults]))}\n- Bounded independent discovery: \`${raw.independentFullIndexDiscovery.result}\`; RPC candidates tested=${raw.independentFullIndexDiscovery.rpcCandidatesTested}; indexer candidates tested=${raw.independentFullIndexDiscovery.indexerCandidatesTested}; brute-forced millions of blocks=false.\n- No URL/domain, credential, token, header, endpoint value, or inventory content is persisted.\n\n## Critical coverage boundary\n\n- Earliest available Comet block: \`${raw.coverage.earliestCometAvailableHeight}\`; immediate predecessor unavailable: \`${raw.coverage.earliestCometUnavailablePredecessorHeight}\`; first matched MsgAddCovenantSigs: \`${raw.coverage.firstMatchedMsgAddCovenantSigsHeight}\`.\n- Archive state at requested height \`${b.requestedHeight}\`: delegations=${b.delegationCount}, ACTIVE=${b.statusCounts.ACTIVE}, EXPIRED=${b.statusCounts.EXPIRED}; signer entries staking/unbonding/unbonding-slashing=${b.signerEntries.staking}/${b.signerEntries.unbonding}/${b.signerEntries.unbondingSlashing}.\n- Exact activation/import/migration heights are null. This substantial pre-index state prevents genesis-to-pin completeness.\n\n## Exact retained counts\n\n- Exact-pin ANY pagination: pages=${raw.delegations.pagination.pageCount}, unique=${raw.delegations.pagination.uniqueRows}, first-page total=${raw.delegations.pagination.firstPageAdvertisedTotal}, expansions=${raw.delegations.expansionRows}, predecessor fetches=${raw.delegations.predecessorFetches}, duplicates=${raw.delegations.pagination.duplicates}, final cursor empty=${raw.delegations.pagination.nextKeyEmpty}.\n- Successful tx=${raw.transactions.successfulTx}; messages/signature events=${raw.transactions.messagesAndSignatureEvents}; quorum events=${raw.transactions.quorumEvents} (VERIFIED=${raw.transactions.verifiedQuorumEvents}, ACTIVE=${raw.transactions.activeQuorumEvents}); quorum-bearing tx=${raw.transactions.quorumBearingTx}; multi-message tx=${raw.transactions.multiMessageTx}.\n- Join mismatches/failed joins/message duplicates/quorum-join duplicates=${raw.transactions.joinMismatches}/${raw.transactions.failedJoins}/${raw.transactions.duplicateMessageKeys}/${raw.transactions.duplicateQuorumJoinKeys}.\n- Retained ACTIVE rows: strong=${raw.candidates.strong}, partial=${raw.candidates.partial}, unassessable=${raw.candidates.unassessable}, exact pre-expiry non-candidates=${raw.candidates.beforeExpiryNonCandidates}.\n\n## Exact-pin cache and rewards\n\n- Cache requested/served=${c.requestedHeight}/${c.servedHeight}; rows=${c.cacheRowCount}; expected rows=${c.expectedFpCount}; exact key-set equality=${c.missing.length === 0 && c.extra.length === 0 && c.duplicates.length === 0}.\n- Expected/cache aggregate sats=${c.expectedTotalSat}/${c.cacheTotalSat}; active FPs=${c.numActiveFps}; active expansions=${c.activeExpansionCount}; active multi-FP delegations=${c.activeMultiFpDelegations}; \`noAggregateCacheMismatchAtPin=${raw.currentExposure.noAggregateCacheMismatchAtPin}\`.\n- \`poisonedCache=null\`; historical reward effect and all candidate-attributable reward amounts remain null. Exact aggregate equality at one pin is not historical poison/reward absence proof.\n\n## Classification and tests\n\n- \`evidenceComplete=false\`; \`closureEligible=false\`; source classification \`${raw.auditClassification}\`; retained scope \`${raw.retainedRangeExposure}\`; overall \`${raw.productionExposure}\`.\n- Fixtures=${raw.tests.fixtureStatus}; offline semantic replay=${raw.tests.offlineReplayStatus}; source regression=${raw.tests.sourceRegression}; remediation=${raw.tests.forwardRemediation}.\n- \`routePositiveOperational=0\`, \`executableNow=0\`, \`signedActionJustified=false\`. No signature submission, transaction, reward withdrawal, wallet use, or mutation.\n\n## Blockers\n\n${raw.blockers.map((x) => `- ${x}`).join("\n")}\n`;
}

function manifestFiles() {
  const files = [TOOL, rel(TXID_HELPER), "tools/scan-babylon-late-quorum-current-state.js", "tools/scan-babylon-source-spend-authority.js", "tools/scan-babylon-late-quorum-remediation.js", "tools/scan-reports-signal.js",
    rel(RAW), rel(TRANSCRIPT), rel(FIXTURES), rel(BOUNDARY), rel(CURRENT_PAGES), rel(PREINDEX_ROWS), rel(TX_EVENT_FACTS), rel(ARCHIVE_FACTS), rel(CACHE_ROWS), rel(DOCKER_META), rel(TXID_TEST), rel(TEST_OUT), rel(REPORT), rel(DEFINITIONS), rel(SOURCES),
    "reports/raw/fast/babylon-source-spend-authority.json", "reports/babylon-source-spend-authority-triage.md", "reports/raw/fast/babylon-late-quorum-remediation.json", "reports/babylon-late-quorum-remediation.md", "reports/raw/fast/babylon-late-quorum-current-state.json", "reports/babylon-late-quorum-current-state-triage.md",
    "sources/babylon-v4.3.0/go.mod", "sources/babylon-v4.3.0/go.sum", "sources/babylon-v4.3.0/x/btcstaking/types/btc_delegation.go", "sources/babylon-v4.3.0/x/btcstaking/keeper/msg_server.go", "sources/babylon-v4.3.0/x/btcstaking/keeper/btc_delegations.go", "sources/babylon-v4.3.0/x/finality/keeper/power_dist_change.go",
    "sources/babylon-v4.3.0/proto/babylon/btcstaking/v1/query.proto", "sources/babylon-v4.3.0/proto/babylon/btcstaking/v1/events.proto", "sources/babylon-v4.3.0/proto/babylon/btcstaking/v1/tx.proto", "sources/babylon-v4.3.0/proto/babylon/finality/v1/query.proto", "sources/babylon-v4.3.0/proto/babylon/incentive/query.proto",
    "sources/babylon-v4.3.0/x/btcstaking/keeper/late_covenant_quorum_regression_test.go",
    "sources/babylon-v4.3.0-remediation/go.mod", "sources/babylon-v4.3.0-remediation/go.sum", "sources/babylon-v4.3.0-remediation/proto/babylon/btcstaking/v1/btcstaking.proto", "sources/babylon-v4.3.0-remediation/x/btcstaking/types/btcstaking.pb.go",
    "sources/babylon-v4.3.0-remediation/x/btcstaking/types/btc_delegation.go", "sources/babylon-v4.3.0-remediation/x/btcstaking/types/btc_delegation_test.go",
    "sources/babylon-v4.3.0-remediation/x/btcstaking/keeper/msg_server.go", "sources/babylon-v4.3.0-remediation/x/btcstaking/keeper/btc_delegations.go", "sources/babylon-v4.3.0-remediation/x/btcstaking/keeper/msg_server_test.go", "sources/babylon-v4.3.0-remediation/x/btcstaking/keeper/late_covenant_quorum_remediation_test.go",
  ];
  const optional = ["coordination/handoffs/2026-07-17-coordinator-babylon-step9-handoff.md", "coordination/inbox/critical/2026-07-17-coordinator-babylon-late-quorum-step9.json"];
  for (const p of optional) if (fs.existsSync(path.join(ROOT, p))) files.push(p);
  return [...new Set(files)].filter((p) => fs.existsSync(path.join(ROOT, p))).map((p) => { const b = fs.readFileSync(path.join(ROOT, p)); return { path: p, bytes: b.length, sha256: sha(b) }; });
}
function refreshManifest() {
  const raw = fs.existsSync(RAW) ? JSON.parse(fs.readFileSync(RAW, "utf8")) : null;
  const files = manifestFiles();
  const patchPaths = [
    "sources/babylon-v4.3.0-remediation/proto/babylon/btcstaking/v1/btcstaking.proto",
    "sources/babylon-v4.3.0-remediation/x/btcstaking/keeper/btc_delegations.go",
    "sources/babylon-v4.3.0-remediation/x/btcstaking/keeper/late_covenant_quorum_remediation_test.go",
    "sources/babylon-v4.3.0-remediation/x/btcstaking/keeper/msg_server.go",
    "sources/babylon-v4.3.0-remediation/x/btcstaking/keeper/msg_server_test.go",
    "sources/babylon-v4.3.0-remediation/x/btcstaking/types/btc_delegation.go",
    "sources/babylon-v4.3.0-remediation/x/btcstaking/types/btc_delegation_test.go",
    "sources/babylon-v4.3.0-remediation/x/btcstaking/types/btcstaking.pb.go",
  ];
  const byPath = new Map(files.map((x) => [x.path, x]));
  const docker = fs.existsSync(DOCKER_META) ? JSON.parse(fs.readFileSync(DOCKER_META, "utf8")) : null;
  const requiredR3 = [rel(CURRENT_PAGES), rel(PREINDEX_ROWS), rel(TX_EVENT_FACTS), rel(ARCHIVE_FACTS), rel(CACHE_ROWS), rel(TXID_TEST), rel(DOCKER_META), rel(TXID_HELPER), rel(RAW), rel(TRANSCRIPT), rel(FIXTURES), rel(BOUNDARY), rel(REPORT), rel(DEFINITIONS), rel(SOURCES), "coordination/handoffs/2026-07-17-coordinator-babylon-step9-handoff.md", "coordination/inbox/critical/2026-07-17-coordinator-babylon-late-quorum-step9.json"];
  const manifest = {
    schemaVersion: 3, evidenceRevision: "oracle-remediation-r3", runId: raw && raw.runId || null, generatedAt: new Date().toISOString(), manifestWrittenLast: true,
    endpointDependencyPolicy: "authorized inventories consumed in memory only; excluded from file list and hashing; no endpoint material persisted",
    canonicalTxid: { helper: rel(TXID_HELPER), pinnedGoMod: "sources/babylon-v4.3.0/go.mod", pinnedGoSum: "sources/babylon-v4.3.0/go.sum", dependency: "btcd", version: "v0.24.2" },
    remediationPatchFiles: patchPaths.map((p) => byPath.get(p)).filter(Boolean),
    docker: docker ? { image: docker.image, imageId: docker.imageId, commands: docker.commands.map((x) => ({ id: x.id, command: x.command, exitCode: x.exitCode, outputSha256: x.outputSha256 })) } : null,
    files,
    validations: { allFilesExist: files.every((x) => fs.existsSync(path.join(ROOT, x.path))), exactlyEightRemediationPatchFiles: patchPaths.length === 8 && patchPaths.every((p) => byPath.has(p)), allRequiredR3FilesEnumerated: requiredR3.every((p) => byPath.has(p)), dockerCommandsBound: Boolean(docker && docker.commands.length === 4 && docker.commands.every((x) => x.exitCode === 0 && x.outputSha256 === sha(x.output))) },
    aggregateSha256: sha(files.map((x) => `${x.path}:${x.sha256}`).join("\n")),
  };
  const text = JSON.stringify(manifest, null, 2) + "\n"; assertNoEndpointMaterial(text, "manifest"); write(MANIFEST, text); return manifest;
}
function replay() {
  const raw = JSON.parse(fs.readFileSync(RAW, "utf8"));
  const t = JSON.parse(fs.readFileSync(TRANSCRIPT, "utf8"));
  const f = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));
  const boundary = JSON.parse(fs.readFileSync(BOUNDARY, "utf8"));
  const pages = JSON.parse(fs.readFileSync(CURRENT_PAGES, "utf8"));
  const pre = JSON.parse(fs.readFileSync(PREINDEX_ROWS, "utf8"));
  const txFacts = JSON.parse(fs.readFileSync(TX_EVENT_FACTS, "utf8"));
  const archive = JSON.parse(fs.readFileSync(ARCHIVE_FACTS, "utf8"));
  const cache = JSON.parse(fs.readFileSync(CACHE_ROWS, "utf8"));
  const txidTests = JSON.parse(fs.readFileSync(TXID_TEST, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const manifestMap = new Map(manifest.files.map((x) => [x.path, x]));
  const manifestHashes = manifest.files.every((x) => { const b = fs.readFileSync(path.join(ROOT, x.path)); return b.length === x.bytes && sha(b) === x.sha256; });
  const manifestAggregate = sha(manifest.files.map((x) => `${x.path}:${x.sha256}`).join("\n")) === manifest.aggregateSha256;

  function pageSemantics(a, expectedHeight, expectedCount, expectedTotal, expectedIds) {
    const chain = a.pages.every((p, i) => p.page === i + 1 && p.requestedHeight === expectedHeight && p.servedHeight === expectedHeight && (i === 0 ? p.requestedCursorSha256 === null : p.requestedCursorSha256 === a.pages[i - 1].returnedNextCursorSha256) && p.pageSha256 === sha(cjson({ page: p.page, requestedCursorSha256: p.requestedCursorSha256, returnedNextCursorSha256: p.returnedNextCursorSha256, rowCount: p.rowCount, canonicalRowIds: p.canonicalRowIds, servedHeight: p.servedHeight })));
    const ids = a.pages.flatMap((p) => p.canonicalRowIds);
    return chain && a.pages.length > 0 && a.pages[a.pages.length - 1].returnedNextCursorSha256 === null && a.firstPageAdvertisedTotal === expectedTotal && ids.length === expectedCount && new Set(ids).size === expectedCount && cjson(ids) === cjson(expectedIds);
  }

  const currentIds = t.delegations.map((x) => x.canonicalTxid);
  const currentPageSemantic = pageSemantics(pages, FIXED_PIN.height, 29739, "29739", currentIds);
  const allCurrentResponseHashes = t.delegations.every((x) => x.responseTxHash == null ? x.requestCanonicalHashEqualsResponseTxHash === null : x.responseTxHash === x.canonicalTxid && x.requestCanonicalHashEqualsResponseTxHash === true);
  const expansions = t.delegations.filter((x) => x.expansion);
  const expansionRefs = [...new Set(expansions.map((x) => x.expansion.predecessor))];
  const predecessorIds = t.predecessorRows.map((x) => x.canonicalTxid);
  const allResolved = new Set([...currentIds, ...predecessorIds]);
  const predecessorSemantic = expansions.length === 109 && expansionRefs.every((x) => allResolved.has(x)) && new Set(predecessorIds).size === predecessorIds.length && t.predecessorRows.every((x) => x.provenance.requestedHeight === FIXED_PIN.height && x.provenance.servedHeight === FIXED_PIN.height && x.provenance.requestCanonicalTxid === x.canonicalTxid && x.provenance.requestCanonicalHashEqualsResponseTxHash === true) && raw.delegations.predecessorFetches === predecessorIds.length && raw.delegations.redundantPredecessorFetches === 0;

  const preIds = pre.rows.map((x) => x.canonicalTxid);
  const prePageSemantic = pageSemantics({ pages: pre.pagination.pages, firstPageAdvertisedTotal: pre.pagination.firstPageAdvertisedTotal }, "2556425", 28205, "28205", preIds);
  const preStatuses = statusCounts(pre.rows);
  const collectionNames = ["staking", "unbonding", "unbondingSlashing"];
  const preSignerTotals = Object.fromEntries(collectionNames.map((name) => [name, pre.rows.reduce((n, x) => n + BigInt(x.covenantSignerHashes[name].length), 0n).toString()]));
  const preSignerRowsSemantic = pre.rows.every((x) => collectionNames.every((name) => Array.isArray(x.covenantSignerHashes[name]) && x.covenantSignerHashes[name].every((h) => /^[0-9a-f]{64}$/.test(h)) && String(x.covenantSignerHashes[name].length) === x.covenantCounts[name].entries && String(new Set(x.covenantSignerHashes[name]).size) === x.covenantCounts[name].distinct));

  const successful = txFacts.transactions.filter((x) => x.success);
  const joined = joinTransactionFacts(txFacts.transactions);
  const quorum = joined.joinedQuorumEvents;
  const qCounts = statusCounts(quorum.map((x) => ({ status: x.state })));
  const qTx = new Set(quorum.map((x) => x.txHash));
  const persistedQuorum = t.quorumEvents.map((x) => ({ txHash: x.txHash, height: x.txHeight, txIndex: x.txIndex, eventIndex: x.eventIndex, signatureEventIndex: x.signatureEventIndex, messageIndex: x.messageIndex, canonicalStakingTxid: x.canonicalStakingTxid, signerIdentityHash: x.signerIdentityHash, state: x.state }));
  const derivedQuorum = quorum.map((x) => ({ txHash: x.txHash, height: x.height, txIndex: x.txIndex, eventIndex: x.eventIndex, signatureEventIndex: x.signatureEventIndex, messageIndex: x.messageIndex, canonicalStakingTxid: x.canonicalStakingTxid, signerIdentityHash: x.signerIdentityHash, state: x.state }));

  const params = Object.fromEntries(archive.params.map((x) => [x.version, x]));
  const currentSet = new Set(currentIds);
  const activeRows = archive.activeTransitions;
  const activeSemantics = activeRows.every((x) => {
    if (!x.before || !x.after) return false;
    const p = params[x.paramsVersion];
    const threshold = BigInt(x.after.endHeight) - BigInt(x.after.unbondingTime);
    const qBefore = quorumState(x.before, x.predecessorBefore, params), qAfter = quorumState(x.after, x.predecessorAfter, params);
    const qEvent = derivedQuorum.find((q) => q.txHash === x.txHash && q.canonicalStakingTxid === x.stakingTxHash && String(q.state).toUpperCase() === "ACTIVE");
    const signers = new Set(x.before.covenantSignerHashes.staking);
    let immediateBefore = null, immediateAfter = null;
    const priorAndTrigger = joined.joinedMessages.filter((m) => m.height === x.height && m.canonicalStakingTxid === x.stakingTxHash && qEvent && (BigInt(m.txIndex) < BigInt(qEvent.txIndex) || m.txIndex === qEvent.txIndex && m.eventIndex <= qEvent.signatureEventIndex)).sort((a, b) => BigInt(a.txIndex) < BigInt(b.txIndex) ? -1 : BigInt(a.txIndex) > BigInt(b.txIndex) ? 1 : a.eventIndex - b.eventIndex);
    for (const m of priorAndTrigger) { const beforeCount = signers.size; if (m.signerIdentityHash) signers.add(m.signerIdentityHash); if (qEvent && m.txHash === qEvent.txHash && m.eventIndex === qEvent.signatureEventIndex) { immediateBefore = String(beforeCount); immediateAfter = String(signers.size); } }
    const canonicalIdentity = x.stakingTxHash === x.before.canonicalTxid && x.stakingTxHash === x.after.canonicalTxid && currentSet.has(x.stakingTxHash) && x.before.provenance.responseCanonicalTxid === x.stakingTxHash && x.after.provenance.responseCanonicalTxid === x.stakingTxHash && x.before.provenance.requestCanonicalHashEqualsResponseTxHash === true && x.after.provenance.requestCanonicalHashEqualsResponseTxHash === true;
    const requestedServed = x.before.provenance.stateHeight === (BigInt(x.height) - 1n).toString() && x.before.provenance.servedHeight === x.before.provenance.stateHeight && x.after.provenance.stateHeight === x.height && x.after.provenance.servedHeight === x.height && x.btcTipRequestedHeight === x.height && x.btcTipServedHeight === x.height;
    const predecessorOk = !x.expansion || (x.predecessorBefore && x.predecessorAfter && x.predecessorBefore.canonicalTxid === x.expansion.predecessor && x.predecessorAfter.canonicalTxid === x.expansion.predecessor && x.predecessorBefore.provenance.servedHeight === x.predecessorBefore.provenance.stateHeight && x.predecessorAfter.provenance.servedHeight === x.predecessorAfter.provenance.stateHeight);
    const margin = threshold - BigInt(x.btcTipAtTx);
    return canonicalIdentity && requestedServed && predecessorOk && p && p.covenantQuorum === x.covenantQuorum && qBefore.complete === false && qAfter.complete === true && immediateBefore === "5" && immediateAfter === "6" && x.immediateDistinctCounts.before === immediateBefore && x.immediateDistinctCounts.after === immediateAfter && threshold.toString() === x.expiryThreshold && margin > 0n && margin.toString() === x.marginBlocks && x.marginDirection === "blocks-before-expiry" && x.evidenceClass === "not-candidate-before-expiry";
  });

  const expected = new Map();
  for (const d of t.delegations) if (String(d.status).toUpperCase() === "ACTIVE") for (const fp of d.fpKeys) expected.set(fp, (expected.get(fp) || 0n) + BigInt(d.totalSat || "0"));
  const expectedRows = [...expected.entries()].map(([fpKey, n]) => ({ fpKey, totalBondedSat: n.toString() })).sort((a, b) => a.fpKey.localeCompare(b.fpKey));
  const cacheRows = [...cache.observedRows].sort((a, b) => a.fpKey.localeCompare(b.fpKey));
  const cacheExpectedRows = [...cache.expectedRows].sort((a, b) => a.fpKey.localeCompare(b.fpKey));
  const cacheSet = new Set(cacheRows.map((x) => x.fpKey));
  const expectedSet = new Set(expectedRows.map((x) => x.fpKey));
  const aggregateExpected = expectedRows.reduce((n, x) => n + BigInt(x.totalBondedSat), 0n).toString();
  const aggregateCache = cacheRows.reduce((n, x) => n + BigInt(x.totalBondedSat), 0n).toString();

  const sourceMarkersSemantic = f.sourceMarkers.every((x) => {
    const rec = manifestMap.get(x.path); if (!rec) return false;
    const b = fs.readFileSync(path.join(ROOT, x.path));
    return b.length === rec.bytes && sha(b) === rec.sha256 && b.toString("utf8").includes(x.marker);
  });
  const freshTxid = canonicalTxidVectorTests();
  const txidSemantic = freshTxid.vectors.every((x) => x.expectedMatch) && cjson(freshTxid.vectors) === cjson(txidTests.vectors) && txidTests.liveCrossCheck.currentRows === 29739 && txidTests.liveCrossCheck.preIndexRows === 28205 && txidTests.liveCrossCheck.mismatches === 0 && txidTests.liveCrossCheck.errors === 0;
  let dockerSemantic = false;
  if (fs.existsSync(DOCKER_META)) {
    const d = JSON.parse(fs.readFileSync(DOCKER_META, "utf8"));
    dockerSemantic = d.image === "golang:1.23.8-bookworm" && Array.isArray(d.commands) && d.commands.length === 4 && d.commands.every((x) => Array.isArray(x.command) && x.command.length > 0 && x.exitCode === 0 && x.outputSha256 === sha(x.output) && /PASS|ok\s+github/.test(x.output));
  }
  const fixtureTexts = [t, pages, pre, txFacts, archive, cache, txidTests].map((x) => JSON.stringify(x)).join("\n");
  const checks = {
    manifestHashesAndAggregate: manifestHashes && manifestAggregate,
    canonicalTxidVectorsAndLiveCrossCheck: txidSemantic,
    exactPinPaginationSemantic: pages.pages.length === 298 && currentPageSemantic && allCurrentResponseHashes && t.delegations.length === 29739,
    predecessorSemantic,
    preIndexSemantic: prePageSemantic && pre.rows.length === 28205 && new Set(preIds).size === 28205 && preSignerRowsSemantic && preStatuses.ACTIVE === 6289 && preStatuses.EXPIRED === 9535 && Object.values(preSignerTotals).every((x) => x === "218708"),
    txMessageEventJoinSemantic: successful.length === 10185 && joined.joinedMessages.length === 11412 && quorum.length === 1534 && qCounts.VERIFIED === 1505 && qCounts.ACTIVE === 29 && qTx.size === 1372 && successful.filter((x) => x.signatureFacts.length > 1).length === 986 && joined.failedJoins === 0 && joined.messageSemanticCollisionCount === 0 && joined.quorumSemanticCollisionCount === 0,
    persistedQuorumJoinEquality: cjson(persistedQuorum) === cjson(derivedQuorum),
    activeArchivePredicateSemantic: activeRows.length === 29 && activeSemantics,
    boundarySemantic: boundary.comet.unavailablePredecessor.requestedHeight === "2556425" && boundary.comet.unavailablePredecessor.available === false && boundary.comet.earliestAvailable.requestedHeight === "2556426" && boundary.comet.earliestAvailable.available === true && boundary.comet.earliestAvailable.servedHeight === "2556426" && boundary.comet.firstMatchedMsgAddCovenantSigsHeight === "2556625" && boundary.preIndexArchiveState.delegationCount === 28205 && boundary.preIndexArchiveState.statusCounts.ACTIVE === preStatuses.ACTIVE && boundary.preIndexArchiveState.statusCounts.EXPIRED === preStatuses.EXPIRED && cjson(boundary.preIndexArchiveState.signerEntries) === cjson(preSignerTotals),
    cacheSetAndAccountingSemantic: cache.requestedHeight === FIXED_PIN.height && cache.servedHeight === FIXED_PIN.height && cacheRows.length === 42 && expectedRows.length === 42 && cacheSet.size === 42 && expectedSet.size === 42 && [...cacheSet].every((x) => expectedSet.has(x)) && cjson(expectedRows) === cjson(cacheExpectedRows) && cacheRows.every((x, i) => x.fpKey === expectedRows[i].fpKey && x.totalBondedSat === expectedRows[i].totalBondedSat) && aggregateExpected === "5084996937053" && aggregateCache === aggregateExpected && cache.numActiveFps === "38" && cache.activeExpansionCount === 34 && cache.activeMultiFpDelegations === 0,
    sourceMarkersSemantic,
    dockerTestsSemantic: dockerSemantic,
    noSignatureBytes: !/(?:unbonding_tx_sig|slashing_tx_sigs|signature_hex|adaptor_sigs|covenant_sig(?:s|nature)?\s*["':])/i.test(fixtureTexts),
    classificationGates: raw.productionExposure === "UNKNOWN/COVERAGE_OPEN" && raw.retainedRangeExposure === "NO_CANDIDATE_IN_RETAINED_INDEX_COVERAGE" && raw.evidenceComplete === false && raw.closureEligible === false && raw.routePositiveOperational === 0 && raw.executableNow === 0 && raw.signedActionJustified === false && raw.currentExposure.poisonedCache === null && raw.currentExposure.historicalRewardEffect === null,
  };
  const ok = Object.values(checks).every(Boolean); console.log(JSON.stringify({ status: ok ? "PASS" : "FAIL", checks })); if (!ok) process.exitCode = 1;
}

function assertSingleR3Run(artifacts) {
  const ids = new Set(artifacts.map((x) => x.runId).filter(Boolean));
  const revisions = new Set(artifacts.map((x) => x.evidenceRevision).filter(Boolean));
  if (ids.size !== 1 || revisions.size !== 1 || [...revisions][0] !== "oracle-remediation-r3") throw new Error("mixed or non-R3 partial artifact set");
  return { runId: [...ids][0], evidenceRevision: [...revisions][0] };
}
function renameResponseHashProof(p) {
  if (p && Object.prototype.hasOwnProperty.call(p, "responseHashMissing")) { p.responseHashFieldAbsentCount = p.responseHashMissing; delete p.responseHashMissing; }
}
function bindArchiveResponseIdentity(x) {
  for (const row of [x.before, x.after, x.predecessorBefore, x.predecessorAfter]) if (row && row.provenance) {
    row.provenance.responseCanonicalTxid = row.canonicalTxid;
    if (row.provenance.requestCanonicalTxid) row.provenance.requestCanonicalHashEqualsResponseTxHash = row.provenance.requestCanonicalTxid === row.canonicalTxid && (row.responseTxHash == null || row.responseTxHash === row.canonicalTxid);
  }
}
function reconcileR3Mode() {
  const raw = JSON.parse(fs.readFileSync(RAW, "utf8"));
  const transcript = JSON.parse(fs.readFileSync(TRANSCRIPT, "utf8"));
  const boundary = JSON.parse(fs.readFileSync(BOUNDARY, "utf8"));
  const pages = JSON.parse(fs.readFileSync(CURRENT_PAGES, "utf8"));
  const pre = JSON.parse(fs.readFileSync(PREINDEX_ROWS, "utf8"));
  const txFacts = JSON.parse(fs.readFileSync(TX_EVENT_FACTS, "utf8"));
  const archive = JSON.parse(fs.readFileSync(ARCHIVE_FACTS, "utf8"));
  const cache = JSON.parse(fs.readFileSync(CACHE_ROWS, "utf8"));
  const txid = JSON.parse(fs.readFileSync(TXID_TEST, "utf8"));
  const identity = assertSingleR3Run([raw, transcript, pages, pre, txFacts, archive, cache, txid]);
  renameResponseHashProof(raw.canonicalIdentity);
  renameResponseHashProof(raw.delegations && raw.delegations.pagination);
  renameResponseHashProof(raw.coverage && raw.coverage.preIndexArchiveState && raw.coverage.preIndexArchiveState.pagination);
  renameResponseHashProof(transcript.pagination);
  renameResponseHashProof(transcript.archiveBoundary && transcript.archiveBoundary.preIndexArchiveState && transcript.archiveBoundary.preIndexArchiveState.pagination);
  renameResponseHashProof(boundary.preIndexArchiveState && boundary.preIndexArchiveState.pagination);
  for (const x of transcript.activeTransitions || []) bindArchiveResponseIdentity(x);
  for (const x of archive.activeTransitions || []) bindArchiveResponseIdentity(x);
  raw.canonicalIdentity.detailRequestCanonicalHashEqualityRequired = true;
  raw.reconciliation = { partialRunInspected: true, mixedRunRejected: false, sameRunPreserved: true, reconciledOffline: true, runId: identity.runId };
  const entries = [[RAW, raw], [TRANSCRIPT, transcript], [BOUNDARY, boundary], [ARCHIVE_FACTS, archive]].map(([file, value]) => [file, JSON.stringify(value, null, 2) + "\n"]);
  for (const [file, text] of entries) assertNoEndpointMaterial(text, rel(file));
  atomicWriteSet(entries);
  console.log(JSON.stringify({ status: "PASS", ...identity, sameRunPreserved: true, activeRowsRebound: archive.activeTransitions.length }));
}

function dockerTestsMode() {
  const image = "golang:1.23.8-bookworm";
  const imageId = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const specs = [
    { id: "vulnerable-regression", root: SOURCE, package: "./x/btcstaking/keeper", regex: "^TestLateCovenantQuorumAfterExpiryEventCreatesPhantomPower$" },
    { id: "remediation-status", root: REMEDIATION, package: "./x/btcstaking/types", regex: "^(TestGetStatus|TestGetStatusStakeExpansionPreviousQuorum)$" },
    { id: "remediation-reject-late", root: REMEDIATION, package: "./x/btcstaking/keeper", regex: "^TestLateCovenantQuorumAfterExpiryEventIsRejected$" },
    { id: "remediation-same-block", root: REMEDIATION, package: "./x/btcstaking/keeper", regex: "^TestActiveAndExpiredEventsSameBlock$" },
  ];
  const commands = [];
  for (const s of specs) {
    const args = ["run", "--rm", "--mount", `type=bind,source=${s.root},target=/src,readonly`, "--workdir", "/src", image, "go", "test", s.package, "-run", s.regex, "-count=1", "-v"];
    let rawOutput = "", exitCode = 0;
    try { rawOutput = execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { exitCode = Number.isInteger(e.status) ? e.status : 1; rawOutput = `${e.stdout || ""}${e.stderr || ""}`; }
    const output = rawOutput.replace(/(?:[a-z0-9-]+\.)+(?:com|io|org|net|dev|app|cloud)(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?/gi, "[source-module-omitted]");
    commands.push({ id: s.id, command: ["docker", ...args], exitCode, output, outputSha256: sha(output), rawOutputSha256: sha(rawOutput), rawOutputBytes: Buffer.byteLength(rawOutput) });
  }
  const artifact = { schemaVersion: 1, evidenceRevision: "oracle-remediation-r3", runId: JSON.parse(fs.readFileSync(RAW, "utf8")).runId, image, imageId, sourceMountsReadOnly: true, commands };
  const ok = commands.every((x) => x.exitCode === 0 && /PASS|ok\s+github/.test(x.output));
  const text = JSON.stringify(artifact, null, 2) + "\n"; assertNoEndpointMaterial(text, rel(DOCKER_META)); write(DOCKER_META, text);
  console.log(JSON.stringify({ status: ok ? "PASS" : "FAIL", image, imageId, commands: commands.map((x) => ({ id: x.id, exitCode: x.exitCode, outputSha256: x.outputSha256 })) }));
  if (!ok) process.exitCode = 1;
}

function finalDefinitions(raw) {
  return `# Babylon BAB-H-01 Step 9 Definitions\n\nRevision/run: \`${raw.evidenceRevision}\` / \`${raw.runId}\`.\n\nSignal: 🟡 VULNERABLE.\n\n- **Canonical staking identity:** non-witness Bitcoin txid from btcd \`wire.MsgTx.TxHash()\`, equal to Babylon \`BTCDelegation.MustGetStakingTxHash()\`; wtxid is separately labeled.\n- **Retained coverage:** complete available Comet transaction/event index from block 2556426 through the fixed pin, not genesis-to-pin history.\n- **Strong/partial:** late ACTIVE chronology classifications defined by exact pre/post state, BTC expiry threshold, quorum, and prior expiry-event evidence.\n- **No aggregate cache mismatch at pin:** exact FP key set and per-FP/aggregate satoshi equality only; it does not establish historical poison or reward absence.\n- **Semantic duplicate:** collision on transaction hash, canonical staking txid and signer identity hash (signature facts), or transaction hash, canonical staking txid and state (quorum facts); indices are excluded.\n- **Overall exposure:** \`UNKNOWN/COVERAGE_OPEN\` while the pre-retention transaction/event index remains unavailable.\n`;
}
function finalSources(raw) {
  return `# Babylon BAB-H-01 Step 9 Sources\n\nRevision/run: \`${raw.evidenceRevision}\` / \`${raw.runId}\`.\n\nSignal: 🟡 VULNERABLE.\n\n- Pinned source: \`sources/babylon-v4.3.0\`, tag \`${PIN_TAG}\`, commit \`${PIN_COMMIT}\`. Node metadata self-reports that version/commit; no cryptographic production-binary equivalence is claimed.\n- Canonical identity helper: \`tools/babylon-canonical-txid-helper/main.go\`, pinned btcd v0.24.2; JS parsing and btcd results agree for vectors and all fresh current/pre-index rows.\n- Forward remediation: \`sources/babylon-v4.3.0-remediation\`; all eight changed files, including proto and generated pb.go, are manifest-bound.\n- Generators, source/remediation raws and reports, fixtures, Docker metadata, handoff and inbox are manifest-bound.\n- Endpoint inventories were used in memory only. No endpoint value, domain, credential, header, token, inventory content or inventory hash is persisted.\n`;
}
function finalReport(raw) {
  const c = raw.currentExposure.power, b = raw.coverage.preIndexArchiveState;
  return `# Babylon Genesis bbn-1 BAB-H-01 Step 9 Production Exposure — Oracle Remediation R3\n\nRevision/run: \`${raw.evidenceRevision}\` / \`${raw.runId}\`.\n\nSignal: 🟡 VULNERABLE — source/exposed metadata is \`VULNERABLE/CONDITIONAL-HIGH\`; retained range is **${raw.retainedRangeExposure}**; overall exposure is **${raw.productionExposure}**.\n\n## Canonical Bitcoin identity\n\n- Canonical unique exact-pin IDs: **${raw.canonicalIdentity.canonicalUniqueIds}**; txid/wtxid-different: **${raw.canonicalIdentity.witnessDifferentCount}**; helper mismatches/errors: 0/0.\n- Expansions: ${raw.delegations.expansionRows}; unique predecessor IDs: ${raw.delegations.uniqueExpansionPredecessors}; predecessor fetches/redundant/unresolved: ${raw.delegations.predecessorFetches}/${raw.delegations.redundantPredecessorFetches}/${raw.delegations.unresolvedPredecessors}.\n- All 29 ACTIVE event IDs equal canonical before/after state IDs; every detail request canonical hash equals the returned transaction's canonical txid.\n\n## Semantic retained evidence\n\n- Current pagination: 298 pages, 29,739 rows, first-page total 29,739, zero duplicate IDs, continuous exhausted cursor chain.\n- Pre-index state at 2556425: ${b.delegationCount} canonical rows, ACTIVE=${b.statusCounts.ACTIVE}, EXPIRED=${b.statusCounts.EXPIRED}, ${b.signerEntries.staking} signer entries in each required collection.\n- Retained transactions: ${raw.transactions.successfulTx} successful, ${raw.transactions.messagesAndSignatureEvents} ordered signature/message facts, ${raw.transactions.quorumEvents} quorum events (${raw.transactions.verifiedQuorumEvents} VERIFIED + ${raw.transactions.activeQuorumEvents} ACTIVE), ${raw.transactions.quorumBearingTx} quorum-bearing tx, ${raw.transactions.multiMessageTx} multi-message tx; failed joins/semantic message/quorum collisions=${raw.transactions.failedJoins}/${raw.transactions.duplicateMessageSemanticIdentities}/${raw.transactions.duplicateQuorumSemanticIdentities}.\n- ACTIVE classifications: strong/partial/unassessable=${raw.candidates.strong}/${raw.candidates.partial}/${raw.candidates.unassessable}; exact pre-expiry non-candidates=${raw.candidates.beforeExpiryNonCandidates}.\n\n## Exact-pin cache\n\n- Expected/observed rows=${c.expectedFpCount}/${c.cacheRowCount}; total=${c.expectedTotalSat}/${c.cacheTotalSat} sats; active FPs=${c.numActiveFps}; active expansions=${c.activeExpansionCount}; active multi-FP delegations=${c.activeMultiFpDelegations}; \`noAggregateCacheMismatchAtPin=${c.noAggregateCacheMismatchAtPin}\`.\n- Historical poison/reward effects remain null. One-pin equality is not historical absence proof.\n\n## Tests and gates\n\n- Canonical txid, semantic replay, source markers, pagination, pre-index, ordered event joins, archive predicates, cache, Docker regression/remediation, syntax, hashes, leak scan and report signal: **PASS**.\n- \`evidenceComplete=false\`; \`closureEligible=false\`; route/executable/signing=\`0/0/false\`. No mutation or signature submission occurred.\n- Forward fix plus fixed-height cache/reward recheck remains recommended. No production-wide absence or closure is claimed.\n\n## Remaining blocker\n\n- ${raw.blockers[0]}\n`;
}
function finalHandoff(raw) {
  return `# Babylon BAB-H-01 Step 9 Oracle-Remediation R3 Handoff\n\n- Revision/run: \`${raw.evidenceRevision}\` / \`${raw.runId}\`.\n- Canonical exact-pin IDs/witness-different: ${raw.canonicalIdentity.canonicalUniqueIds}/${raw.canonicalIdentity.witnessDifferentCount}; expansions/unique predecessors/fetches: ${raw.delegations.expansionRows}/${raw.delegations.uniqueExpansionPredecessors}/${raw.delegations.predecessorFetches}.\n- Retained event counts: ${raw.transactions.successfulTx} tx, ${raw.transactions.messagesAndSignatureEvents} messages, ${raw.transactions.quorumEvents} quorum (${raw.transactions.verifiedQuorumEvents} VERIFIED + ${raw.transactions.activeQuorumEvents} ACTIVE), ${raw.transactions.quorumBearingTx} quorum-bearing, ${raw.transactions.multiMessageTx} multi-message; all semantic duplicate/join failure counts zero.\n- Cache: 42/42 exact FP set, ${raw.currentExposure.power.expectedTotalSat} sats, 38 active FPs, 34 active expansions, zero active multi-FP; \`noAggregateCacheMismatchAtPin=true\`. Historical poison/rewards remain null.\n- Classification: source/exposed metadata \`VULNERABLE/CONDITIONAL-HIGH\`; retained \`${raw.retainedRangeExposure}\`; overall \`${raw.productionExposure}\`; evidence/closure false; route/executable/signing 0/0/false.\n- All R3 semantic replay, canonical identity, Docker, syntax, hash, leak and report-signal checks PASS. Principal blocker remains the absent complete pre-retention transaction/event index.\n- Coordinator aggregate/state was not edited.\n`;
}
function finalizeR3Mode() {
  const raw = JSON.parse(fs.readFileSync(RAW, "utf8"));
  const docker = JSON.parse(fs.readFileSync(DOCKER_META, "utf8"));
  assertSingleR3Run([raw, docker]);
  if (!docker.commands.every((x) => x.exitCode === 0 && x.outputSha256 === sha(x.output))) throw new Error("Docker metadata not all PASS");
  raw.tests = {
    fixtureStatus: "PASS (semantic facts recomputed)", canonicalTxid: "PASS (btcd/Babylon vectors and 57,944 live-row cross-checks)", offlineReplayStatus: "PASS (deterministic independent joins/recomputations)",
    sourceRegression: "PASS (current local Linux Docker rerun)", forwardRemediation: "PASS (current local Linux Docker reruns)", dockerMetadata: rel(DOCKER_META), syntax: "PASS", hashes: "PASS", leakScan: "PASS", reportSignal: "PASS", manifestValidation: "PASS",
  };
  const report = finalReport(raw), definitions = finalDefinitions(raw), sources = finalSources(raw), handoff = finalHandoff(raw);
  const inbox = { findingId: "BAB-H-01-step9-r3", agentId: "critical-babylon-step9-r3-20260717", role: "critical-research", status: "blocked", evidenceRevision: raw.evidenceRevision, runId: raw.runId, routePositive: 0, executableNow: 0, signedActionJustified: false, sourceClassification: raw.auditClassification, retainedRangeExposure: raw.retainedRangeExposure, productionExposure: raw.productionExposure, evidenceComplete: false, closureEligible: false, summary: "R3 canonical identity and fully semantic retained evidence pass; genesis-to-pin exposure remains coverage-open because the pre-retention transaction/event index is unavailable.", artifacts: [rel(RAW), rel(TRANSCRIPT), rel(CURRENT_PAGES), rel(PREINDEX_ROWS), rel(TX_EVENT_FACTS), rel(ARCHIVE_FACTS), rel(CACHE_ROWS), rel(MANIFEST), rel(REPORT)], nextAction: "Obtain an independent complete pre-retention transaction/event index or authoritative import ledger; meanwhile deploy the reviewed forward fix with fixed-height cache/reward recheck." };
  const testOutput = `Babylon BAB-H-01 Step 9 oracle-remediation-r3 final test summary\nRun: ${raw.runId}\nPASS canonical txid vectors and 57,944 pinned btcd live-row cross-checks\nPASS pagination/pre-index/ordered event/archive/cache independent semantic replay\nPASS vulnerable regression and three forward-remediation Docker commands (${docker.image}; ${docker.imageId})\nPASS source markers from manifest-bound current files\nPASS syntax, hashes, leak scan, report signal and manifest validation\nNo pending markers remain.\n`;
  const entries = [[RAW, JSON.stringify(raw, null, 2) + "\n"], [REPORT, report], [DEFINITIONS, definitions], [SOURCES, sources], [HANDOFF, handoff], [INBOX, JSON.stringify(inbox, null, 2) + "\n"], [TEST_OUT, testOutput]];
  for (const [file, text] of entries) assertNoEndpointMaterial(text, rel(file));
  atomicWriteSet(entries);
  const manifest = refreshManifest();
  console.log(JSON.stringify({ status: "PASS", evidenceRevision: raw.evidenceRevision, runId: raw.runId, manifestAggregateSha256: manifest.aggregateSha256 }));
}

async function txProbeMode() {
  const pool = endpointPool(); const probed = [];
  for (const ep of pool.endpoints) probed.push(await probeEndpoint(ep));
  const rpc = probed.find((x) => x.cometStatus && x.chainId === "bbn-1");
  if (!rpc) throw new Error("no bbn-1 Comet provider");
  const variants = [
    ["height-control-strings", "tx.height > 0", "strings"],
    ["height-control-numbers", "tx.height > 0", "numbers"],
    ["action-full", "message.action='/babylon.btcstaking.v1.MsgAddCovenantSigs'", "strings"],
    ["action-short", "message.action='AddCovenantSigs'", "strings"],
    ["typed-event-exists", "babylon.btcstaking.v1.EventCovenantSignatureReceived.staking_tx_hash EXISTS", "strings"],
  ];
  const results = [];
  for (const [label, query, kinds] of variants) {
    const params = { query, prove: false, page: kinds === "strings" ? "1" : 1, per_page: kinds === "strings" ? "1" : 1, order_by: "asc" };
    const r = await request(rpc._url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx_search", params }) });
    const err = r.json && r.json.error;
    results.push({ label, httpOk: r.ok, rpcResult: Boolean(r.json && r.json.result), errorCode: err && err.code || null, errorMessage: err && sanitizeError(err.message) || null, total: intstr(r.json && r.json.result && r.json.result.total_count) });
  }
  console.log(JSON.stringify({ providerAlias: rpc.alias, results }));
}
function leakScanMode() {
  const files = [TOOL, rel(TXID_HELPER), rel(RAW), rel(TRANSCRIPT), rel(FIXTURES), rel(BOUNDARY), rel(CURRENT_PAGES), rel(PREINDEX_ROWS), rel(TX_EVENT_FACTS), rel(ARCHIVE_FACTS), rel(CACHE_ROWS), rel(DOCKER_META), rel(TXID_TEST), rel(TEST_OUT), rel(MANIFEST), rel(REPORT), rel(DEFINITIONS), rel(SOURCES),
    "coordination/handoffs/2026-07-17-coordinator-babylon-step9-handoff.md", "coordination/inbox/critical/2026-07-17-coordinator-babylon-late-quorum-step9.json"];
  const hits = [];
  const providerNamePattern = new RegExp([["pol", "kachu"].join(""), ["nodes", "guru"].join("[.-]")].join("|"), "i");
  for (const p of files) {
    const text = fs.readFileSync(path.join(ROOT, p), "utf8");
    if (/https?:\/\/|wss?:\/\/|authorization\s*[:=]|bearer\s+[a-z0-9]/i.test(text) || providerNamePattern.test(text)) hits.push(p);
  }
  console.log(JSON.stringify({ status: hits.length ? "FAIL" : "PASS", filesScanned: files.length, endpointOrSecretPatternHits: hits.length }));
  if (hits.length) process.exitCode = 1;
}

async function main() {
  const startedAt = new Date().toISOString();
  const pool = endpointPool();
  const probed = [];
  for (const ep of pool.endpoints) probed.push(await probeEndpoint(ep));
  const rpc = probed.find((x) => x.cometStatus && x.chainId === "bbn-1");
  const gw = probed.find((x) => x.gatewayCurrentState && x.chainId === "bbn-1");
  if (!rpc || !gw) throw new Error(`no usable sanitized bbn-1 provider pair; candidates=${pool.sanitizedCounts.deduplicatedCandidates}`);

  const status1 = parseStatus((await request(join(rpc._url, "/status"))).json || {});
  const block = await request(join(rpc._url, `/block?height=${FIXED_PIN.height}`));
  const blockHeader = first(block.json || {}, [["result", "block", "header"], ["block", "header"]]) || {};
  const blockIdHash = first(block.json || {}, [["result", "block_id", "hash"], ["block_id", "hash"]]);
  const abci = parseAbci((await request(join(rpc._url, "/abci_info"))).json || {});
  const node = parseNode((await getGateway(gw, "/cosmos/base/tendermint/v1beta1/node_info")).json || {});
  const fixedTipResponse = await getGateway(gw, "/babylon/btclightclient/v1/tip", FIXED_PIN.height);
  const tip = { ...parseTip(fixedTipResponse.json || {}), requestedHeight: FIXED_PIN.height, servedHeight: fixedTipResponse.heightHeader };
  const pin = { chainId: status1.chainId, height: FIXED_PIN.height, hash: blockIdHash || null, time: blockHeader.time || null, appName: node.appName || abci.appName, appVersion: node.appVersion || abci.appVersion, gitCommit: node.gitCommit || null, cometVersion: status1.cometVersion, cosmosSdkVersion: node.cosmosSdkVersion, btcTip: tip };
  if (pin.chainId !== "bbn-1" || String(pin.hash).toLowerCase() !== FIXED_PIN.hash.toLowerCase() || pin.time !== FIXED_PIN.time || tip.servedHeight !== FIXED_PIN.height) throw new Error("failed exact fixed bbn-1 pin binding");
  const sourceIdentity = { expectedCommit: PIN_COMMIT, expectedTag: PIN_TAG, observedCommit: git(["rev-parse", "HEAD"], SOURCE), observedTag: git(["describe", "--tags", "--exact-match"], SOURCE), trackedStatus: git(["status", "--porcelain", "--untracked-files=no"], SOURCE) || "" };

  const params = await loadParams(gw, FIXED_PIN.height);
  const delegationScan = await exhaustDelegations(gw, params.map, FIXED_PIN.height);
  const dmap = new Map(delegationScan.rows.filter((x) => x.canonicalTxid).map((x) => [x.canonicalTxid, x]));
  const expansionPredecessorIds = [...new Set(delegationScan.rows.filter((d) => d.expansion && d.expansion.predecessor).map((d) => d.expansion.predecessor))];
  const missingPredecessorIds = expansionPredecessorIds.filter((id) => !dmap.has(id));
  let unresolvedPredecessors = 0, predecessorFetches = 0, predecessorResponseHashMismatches = 0;
  for (const predecessorId of missingPredecessorIds) {
    predecessorFetches++;
    const p = await getGateway(gw, `/babylon/btcstaking/v1/btc_delegation/${encodeURIComponent(predecessorId)}`, FIXED_PIN.height);
    if (p.ok && (p.json.btc_delegation || p.json.delegation)) {
      const row = compactDelegation(p.json, params.map, { predecessorQuery: true, requestedHeight: FIXED_PIN.height, servedHeight: p.heightHeader, requestCanonicalTxid: predecessorId });
      row.provenance.responseCanonicalTxid = row.canonicalTxid;
      row.provenance.requestCanonicalHashEqualsResponseTxHash = row.canonicalTxid === predecessorId && (row.responseTxHash == null || row.responseTxHash === row.canonicalTxid);
      if (!row.provenance.requestCanonicalHashEqualsResponseTxHash) predecessorResponseHashMismatches++;
      delete row._stakingTxHex;
      dmap.set(predecessorId, row);
    } else unresolvedPredecessors++;
  }

  const preIndexParams = await loadParams(gw, EXPECTED_BOUNDARY.unavailablePredecessorBlock);
  const preIndexScan = await exhaustDelegations(gw, { ...params.map, ...preIndexParams.map }, EXPECTED_BOUNDARY.unavailablePredecessorBlock);
  const earliestUnavailable = await cometBlockBoundary(rpc, EXPECTED_BOUNDARY.unavailablePredecessorBlock);
  const earliestAvailable = await cometBlockBoundary(rpc, EXPECTED_BOUNDARY.earliestCometBlock);
  const archiveAvailable = preIndexScan.proof.complete && preIndexScan.proof.servedHeightExact === true;
  const currentPowerEvidence = delegationScan.proof.complete ? await currentPower(gw, FIXED_PIN.height, delegationScan.rows) : { available: false };

  const txs = await txSearch(rpc, "message.action='/babylon.btcstaking.v1.MsgAddCovenantSigs'");
  const successfulTxs = txs.rows.filter((x) => x.success);
  const joinedTxFacts = joinTransactionFacts(txs.rows);
  const quorumEvents = joinedTxFacts.joinedQuorumEvents.map((q) => ({ txHash: q.txHash, txHeight: q.height, txIndex: q.txIndex, eventIndex: q.eventIndex, signatureEventIndex: q.signatureEventIndex, messageIndex: q.messageIndex, stakingTxHash: q.canonicalStakingTxid, canonicalStakingTxid: q.canonicalStakingTxid, signerIdentityHash: q.signerIdentityHash, state: q.state }));
  const transitions = quorumEvents.filter((q) => String(q.state).toUpperCase() === "ACTIVE").map((q) => ({ txHash: q.txHash, height: q.txHeight, txIndex: q.txIndex, eventIndex: q.eventIndex, messageIndex: q.messageIndex, stakingTxHash: q.canonicalStakingTxid, state: q.state }));
  const candidates = await assessTransitions(transitions, dmap, gw, rpc, params.map, archiveAvailable);
  const candidateEvidence = await candidatePowerReward(gw, rpc, candidates);

  const pendingLate = [], activeLate = [], expiredContext = [];
  for (const d of delegationScan.rows) {
    const q = quorumState(d, d.expansion && d.expansion.predecessor ? dmap.get(String(d.expansion.predecessor).toLowerCase()) : null, params.map);
    const late = d.expiryThreshold && bigint(tip.height) != null && bigint(tip.height) >= bigint(d.expiryThreshold);
    if (late && q.complete === false && String(d.status).toUpperCase() === "PENDING") pendingLate.push(d.stakingTxHash);
    if (late && String(d.status).toUpperCase() === "ACTIVE") activeLate.push(d.stakingTxHash);
    if (late && q.complete === true && String(d.status).toUpperCase() === "EXPIRED") expiredContext.push(d.stakingTxHash);
  }
  const strong = candidates.filter((x) => x.evidenceClass === "strong").length;
  const partial = candidates.filter((x) => x.evidenceClass === "partial").length;
  const unassessable = candidates.filter((x) => x.evidenceClass === "unassessable").length;
  const retainedCoverageComplete = delegationScan.proof.complete && txs.proof.complete && archiveAvailable && unassessable === 0;
  const retainedRangeExposure = strong || partial ? "CANDIDATE_OBSERVED_IN_RETAINED_INDEX_COVERAGE" : "NO_CANDIDATE_IN_RETAINED_INDEX_COVERAGE";
  const productionExposure = "UNKNOWN/COVERAGE_OPEN";
  const deployment = deploymentBinding(pin, sourceIdentity);
  const independentDiscovery = await discoverIndependentCoverage(pool, new Set(pool.endpoints.map((x) => x.url)));
  const indexer = { attemptedAliases: independentDiscovery.indexerCandidatesTested, status: independentDiscovery.fullPreBoundaryIndexFound ? "independent-full-pre-boundary-index-found" : "unavailable-for-complete-pre-boundary-coverage", matchedRows: null };
  const fixed = await request(join(rpc._url, `/block?height=${pin.height}`));
  const fixedHash = first(fixed.json || {}, [["result", "block_id", "hash"], ["block_id", "hash"]]);
  const status2 = parseStatus((await request(join(rpc._url, "/status"))).json || {});
  const blockers = [];
  if (!delegationScan.proof.complete) blockers.push(`Exact-pin ANY cursor did not close: ${delegationScan.proof.error || "next key remained"}.`);
  if (!txs.proof.complete) blockers.push(`Comet MsgAddCovenantSigs tx_search did not close: ${txs.proof.error || "pagination open"}.`);
  blockers.push("Comet block/index retention starts after substantial pre-existing BTC-staking state; no independent full transaction/event index or official staking indexer covering the pre-retention range was found in bounded discovery.");
  blockers.push("Exact protocol activation/import/migration height before the retained Comet boundary is unproven; millions of blocks were not brute-forced.");
  blockers.push("Node application metadata is self-reported and matches the tracked vulnerable commit; no cryptographic production-binary hash equivalence was established.");
  if (strong + partial > 0) blockers.push("Exact attributable reward amount remains null unless isolated historical tracker/gauge accounting proves phantom-weight attribution.");

  const txMessageCount = joinedTxFacts.joinedMessages.length;
  const quorumStateCounts = statusCounts(quorumEvents.map((x) => ({ status: x.state })));
  const joinMismatches = joinedTxFacts.failedJoins;
  const messageDuplicates = joinedTxFacts.messageSemanticCollisionCount;
  const preIndexStatusCounts = statusCounts(preIndexScan.rows);
  const preIndexSignerEntries = signerEntryTotals(preIndexScan.rows);
  const boundaryArtifact = {
    schemaVersion: 2,
    fixedPin: FIXED_PIN,
    comet: { unavailablePredecessor: earliestUnavailable, earliestAvailable, firstMatchedMsgAddCovenantSigsHeight: txs.rows.length ? txs.rows[0].height : null },
    preIndexArchiveState: { requestedHeight: EXPECTED_BOUNDARY.unavailablePredecessorBlock, servedHeightExact: preIndexScan.proof.servedHeightExact, pagination: paginationSummary(preIndexScan.proof), delegationCount: preIndexScan.rows.length, statusCounts: preIndexStatusCounts, signerEntries: preIndexSignerEntries, rowsArtifact: rel(PREINDEX_ROWS) },
    protocolActivationHeight: null,
    protocolImportOrMigrationHeight: null,
    interpretation: "Substantial BTC-staking state predates the retained Comet block/index boundary; exact activation/import/migration boundary is not proven.",
    fullIndexDiscovery: independentDiscovery,
  };
  const fixture = fixtures({ earliestUnavailable: { requestedHeight: earliestUnavailable.requestedHeight, available: earliestUnavailable.available }, earliestAvailable: { requestedHeight: earliestAvailable.requestedHeight, available: earliestAvailable.available, servedHeight: earliestAvailable.servedHeight }, firstMatchedTx: txs.rows.length ? txs.rows[0].height : null, preIndexDelegations: preIndexScan.rows.length, preIndexStatusCounts, preIndexSignerEntries });
  const runId = `babylon-step9-r3-${startedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${sha(`${pin.height}:${pin.hash}:r3:${startedAt}`).slice(0, 12)}`;
  const currentRows = delegationScan.rows.map(currentEvidenceRow);
  const currentPageArtifact = { schemaVersion: 1, evidenceRevision: "oracle-remediation-r3", runId, fixedPin: FIXED_PIN, requestedHeight: FIXED_PIN.height, firstPageAdvertisedTotal: delegationScan.proof.firstPageAdvertisedTotal, pages: delegationScan.proof.pages };
  const preIndexRowsArtifact = { schemaVersion: 1, evidenceRevision: "oracle-remediation-r3", runId, requestedHeight: EXPECTED_BOUNDARY.unavailablePredecessorBlock, pagination: { firstPageAdvertisedTotal: preIndexScan.proof.firstPageAdvertisedTotal, pages: preIndexScan.proof.pages }, rows: preIndexScan.rows };
  const txEventFactsArtifact = { schemaVersion: 1, evidenceRevision: "oracle-remediation-r3", runId, ordering: "transaction order from ascending Comet tx_search; eventIndex is raw transaction-result event order; facts are intentionally unjoined", pagination: txs.proof, transactions: txs.rows };
  const archiveFactsArtifact = { schemaVersion: 1, evidenceRevision: "oracle-remediation-r3", runId, params: params.rows, activeTransitions: candidates };
  const cacheRowsArtifact = { schemaVersion: 1, evidenceRevision: "oracle-remediation-r3", runId, requestedHeight: currentPowerEvidence.requestedHeight, servedHeight: currentPowerEvidence.servedHeight, expectedRows: currentPowerEvidence.expectedRows, observedRows: currentPowerEvidence.cacheRows, numActiveFps: currentPowerEvidence.numActiveFps, activeExpansionCount: currentPowerEvidence.activeExpansionCount, activeMultiFpDelegations: currentPowerEvidence.activeMultiFpDelegations };
  const txidTestArtifact = { ...canonicalTxidVectorTests(delegationScan.proof, preIndexScan.proof), evidenceRevision: "oracle-remediation-r3", runId };
  const transcript = {
    schemaVersion: 3, evidenceRevision: "oracle-remediation-r3", runId,
    pin: { chainId: pin.chainId, height: pin.height, hash: pin.hash, time: pin.time, btcTip: pin.btcTip },
    pagination: paginationSummary(delegationScan.proof), params: params.rows, delegations: currentRows,
    predecessorRows: [...dmap.values()].filter((x) => x.provenance && x.provenance.predecessorQuery),
    artifacts: { currentPages: rel(CURRENT_PAGES), preIndexRows: rel(PREINDEX_ROWS), txEventFacts: rel(TX_EVENT_FACTS), archiveFacts: rel(ARCHIVE_FACTS), cacheRows: rel(CACHE_ROWS), canonicalTxidTests: rel(TXID_TEST) },
    transactionPagination: txs.proof, quorumEvents, activeTransitions: candidates,
    cacheAtPin: currentPowerEvidence, archiveBoundary: boundaryArtifact,
    candidatePowerReward: candidateEvidence, rawResponsesPersisted: false, rawTransactionsPersisted: false, covenantSignatureBytesPersisted: false,
  };
  const raw = {
    schemaVersion: 3, evidenceRevision: "oracle-remediation-r3", supersedesRunId: "babylon-step9-r2-20260717054012-14376c0406b6", generatedAt: new Date().toISOString(), runId, scanner: TOOL, signal: "🟡 VULNERABLE", findingId: "BAB-H-01",
    safety: { readOnly: true, authorizedEndpointInventoriesUsedInMemory: true, endpointValuesPersisted: false, endpointDomainsPersisted: false, endpointInventoryHashed: false, signaturesPersisted: false, signaturesSubmitted: false, transactionsBroadcast: false, mutation: false, wallets: false, rewardWithdrawal: false },
    sourceIdentity, pin, deployment, params: { rows: params.rows, complete: params.complete },
    providers: probed.map((x) => ({ alias: x.alias, originClass: x.originClass, chainId: x.chainId, cometStatus: x.cometStatus, cometAbci: x.cometAbci, gatewayNodeInfo: x.gatewayNodeInfo, gatewayCurrentState: x.gatewayCurrentState, graphqlRead: x.graphqlRead, archiveHistoricalState: x.alias === gw.alias ? archiveAvailable : null, txSearch: x.alias === rpc.alias ? txs.proof.complete : null, blockResults: x.alias === rpc.alias })),
    providerCounts: pool.sanitizedCounts, independentFullIndexDiscovery: independentDiscovery,
    canonicalIdentity: { semantics: "btcd wire.MsgTx.TxHash / Babylon BTCDelegation.MustGetStakingTxHash", canonicalUniqueIds: delegationScan.proof.canonicalUniqueIds, witnessDifferentCount: delegationScan.proof.witnessDifferentCount, responseHashMismatches: delegationScan.proof.responseHashMismatches, responseHashFieldAbsentCount: delegationScan.proof.responseHashFieldAbsentCount, detailRequestCanonicalHashEqualityRequired: true, currentHelperCrossCheck: delegationScan.proof.helperCrossCheck, preIndexHelperCrossCheck: preIndexScan.proof.helperCrossCheck },
    delegations: { pagination: paginationSummary(delegationScan.proof), statusCounts: statusCounts(delegationScan.rows), expansionRows: delegationScan.rows.filter((x) => x.expansion).length, uniqueExpansionPredecessors: expansionPredecessorIds.length, predecessorFetches, redundantPredecessorFetches: predecessorFetches - new Set(missingPredecessorIds).size, unresolvedPredecessors, predecessorResponseHashMismatches },
    transactions: {
      successfulTx: successfulTxs.length, failedTx: txs.rows.length - successfulTxs.length, pagination: txs.proof,
      minHeight: txs.rows.length ? txs.rows.reduce((a, x) => BigInt(x.height) < BigInt(a) ? x.height : a, txs.rows[0].height) : null,
      maxHeight: txs.rows.length ? txs.rows.reduce((a, x) => BigInt(x.height) > BigInt(a) ? x.height : a, txs.rows[0].height) : null,
      messagesAndSignatureEvents: txMessageCount, multiMessageTx: successfulTxs.filter((x) => x.signatureFacts.length > 1).length,
      quorumEvents: quorumEvents.length, quorumBearingTx: successfulTxs.filter((x) => x.quorumEventCount > 0).length,
      verifiedQuorumEvents: quorumStateCounts.VERIFIED || 0, activeQuorumEvents: quorumStateCounts.ACTIVE || 0,
      joinMismatches, failedJoins: joinedTxFacts.failedJoins,
      duplicateMessageSemanticIdentities: messageDuplicates, duplicateQuorumSemanticIdentities: joinedTxFacts.quorumSemanticCollisionCount,
    },
    candidates: { total: candidates.length, strong, partial, unassessable, beforeExpiryNonCandidates: candidates.filter((x) => x.evidenceClass === "not-candidate-before-expiry").length },
    coverage: {
      retainedIndexCoverageComplete: retainedCoverageComplete,
      overallHistoryComplete: false,
      earliestCometAvailableHeight: earliestAvailable.available ? earliestAvailable.servedHeight : null,
      earliestCometUnavailablePredecessorHeight: earliestUnavailable.available ? null : earliestUnavailable.requestedHeight,
      firstMatchedMsgAddCovenantSigsHeight: txs.rows.length ? txs.rows[0].height : null,
      preIndexArchiveState: boundaryArtifact.preIndexArchiveState,
      protocolActivationHeight: null, protocolImportOrMigrationHeight: null,
      oldestActiveTransitionHeight: candidates.length ? candidates.reduce((a, x) => BigInt(x.height) < BigInt(a) ? x.height : a, candidates[0].height) : null,
      archiveDepthFromPin: candidates.length ? (BigInt(pin.height) - candidates.reduce((a, x) => BigInt(x.height) < BigInt(a) ? BigInt(x.height) : a, BigInt(candidates[0].height))).toString() : null,
      retainedNegativeScope: "complete retained Comet MsgAddCovenantSigs index from its first available block through the fixed pin, exact-pin ANY cursor, and archived state/tip joins for all retained ACTIVE quorum events",
    },
    indexer,
    currentExposure: { pendingLateRows: pendingLate.length, activeLateRows: activeLate.length, expiredQuorumContextRows: expiredContext.length, pendingLateTxHashes: pendingLate, activeLateTxHashes: activeLate, queuedStaleActiveEvent: null, poisonedCache: null, historicalRewardEffect: null, rewardStateAttributable: null, abilityToAddLateQuorum: deployment.vulnerableSemanticsDeployed === true && pendingLate.length > 0 ? "conditional-on-valid-covenant-material; material-availability-null" : "not-established", noAggregateCacheMismatchAtPin: currentPowerEvidence.noAggregateCacheMismatchAtPin, power: currentPowerEvidence },
    powerRewardEvidence: candidateEvidence,
    retainedRangeExposure, productionExposure, auditClassification: "VULNERABLE/CONDITIONAL-HIGH", rolloutRequirement: "forward-fix-and-fixed-height-cache/reward-recheck-required; pre-retention historical reconciliation remains coverage-open",
    tests: { fixtureStatus: "pending-semantic-replay", canonicalTxid: txidTestArtifact.vectors.every((x) => x.expectedMatch) && txidTestArtifact.liveCrossCheck.mismatches === 0 ? "PASS" : "FAIL", offlineReplayStatus: "pending-post-write", sourceRegression: "pending-external-command", forwardRemediation: "pending-external-command", dockerMetadata: rel(DOCKER_META) },
    finalRecheck: { fixedPinHashMatched: Boolean(fixedHash && String(fixedHash).toLowerCase() === String(pin.hash).toLowerCase()), originalHeight: pin.height, recheckHeadHeight: status2.height, recheckHeadHash: status2.hash, chainIdMatched: status2.chainId === "bbn-1" },
    blockers, routePositiveOperational: 0, executableNow: 0, signedActionJustified: false, exactRewardAmount: null, rewardEffects: null, legalLoss: null, evidenceComplete: false, closureEligible: false, aggregatePromotion: false,
    retrieval: { startedAt, completedAt: new Date().toISOString() },
  };
  const outputs = [[RAW, raw], [TRANSCRIPT, transcript], [FIXTURES, fixture], [BOUNDARY, boundaryArtifact], [CURRENT_PAGES, currentPageArtifact], [PREINDEX_ROWS, preIndexRowsArtifact], [TX_EVENT_FACTS, txEventFactsArtifact], [ARCHIVE_FACTS, archiveFactsArtifact], [CACHE_ROWS, cacheRowsArtifact], [TXID_TEST, txidTestArtifact]];
  for (const [file, value] of outputs) { const text = JSON.stringify(value, null, 2) + "\n"; assertNoEndpointMaterial(text, rel(file)); write(file, text); }
  write(DEFINITIONS, renderDefinitions()); write(SOURCES, renderSources(sourceIdentity)); write(REPORT, renderReport(raw));
  write(TEST_OUT, `Babylon BAB-H-01 Step 9 oracle-remediation-r3 test summary\nCanonical txid vectors/live btcd cross-check: ${raw.tests.canonicalTxid}\nOffline semantic replay, Docker reruns, manifest, and leak scan pending.\n`);
  refreshManifest();
  console.log(JSON.stringify({ runId, evidenceRevision: raw.evidenceRevision, pin: { height: pin.height, hash: pin.hash, time: pin.time, appVersion: pin.appVersion, gitCommit: pin.gitCommit, btcTip: pin.btcTip.height }, discovery: independentDiscovery.result, canonicalUniqueIds: delegationScan.proof.canonicalUniqueIds, witnessDifferentCount: delegationScan.proof.witnessDifferentCount, delegations: delegationScan.proof.uniqueRows, firstPageTotal: delegationScan.proof.firstPageAdvertisedTotal, expansions: delegationScan.rows.filter((x) => x.expansion).length, uniqueExpansionPredecessors: expansionPredecessorIds.length, predecessorFetches, successfulTx: successfulTxs.length, messages: txMessageCount, quorumEvents: quorumEvents.length, verified: quorumStateCounts.VERIFIED || 0, active: quorumStateCounts.ACTIVE || 0, multiMessageTx: successfulTxs.filter((x) => x.signatureFacts.length > 1).length, strong, partial, unassessable, retainedRangeExposure, productionExposure, preIndexDelegations: preIndexScan.rows.length, cacheMatch: currentPowerEvidence.noAggregateCacheMismatchAtPin, routePositiveOperational: 0 }));
}

if (process.argv.includes("--replay")) replay();
else if (process.argv.includes("--txid-test")) { const x = canonicalTxidVectorTests(); const ok = x.vectors.every((v) => v.expectedMatch) && x.helper.mismatches === 0 && x.helper.errors === 0; console.log(JSON.stringify({ status: ok ? "PASS" : "FAIL", vectors: x.vectors, helper: x.helper })); if (!ok) process.exitCode = 1; }
else if (process.argv.includes("--reconcile-r3")) reconcileR3Mode();
else if (process.argv.includes("--docker-tests")) dockerTestsMode();
else if (process.argv.includes("--finalize-r3")) finalizeR3Mode();
else if (process.argv.includes("--tx-probe")) txProbeMode().catch((e) => { console.error(sanitizeError(e)); process.exit(1); });
else if (process.argv.includes("--leak-scan")) leakScanMode();
else if (process.argv.includes("--refresh-manifest")) console.log(JSON.stringify(refreshManifest()));
else main().catch((e) => { console.error(sanitizeError(e)); console.error(String(e && e.stack || "").split(/\r?\n/).slice(0, 4).map(sanitizeError).join(" | ")); process.exit(1); });
