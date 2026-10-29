#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const RAW_REL = "reports/raw/fast/lombard-lbtc-ibc-origin-mode.json";
const REPORT_REL = "reports/lombard-lbtc-ibc-origin-mode-triage.md";
const HANDOFF_REL = "coordination/handoffs/2026-07-12-coordinator-lombard-step12-handoff.md";
const CLASSIFICATION = "INCOMPLETE/WATCH — ICS-20 ORIGIN/BRIDGE MODE PARTIAL OR BLOCKED";
const COMMIT = "5ec153c2803991ac2b0240565b1498d85375c7a5";
const SOURCE_REL = "contracts/ibc/IBCVoucher.sol";
const MAX_BYTES = 1_000_000, TIMEOUT_MS = 10_000, WALL_MS = 150_000, MAX_REQUESTS = 160, PAGE_LIMIT = 100, MAX_TRACE_PAGES = 20;

// Auth-free public fallbacks only. Generated artifacts retain generic labels, never endpoints.
const CHAINS = [
  { key: "cosmosHub", name: "Cosmos Hub", chainId: "cosmoshub-4", denom: "ibc/DBD9E339E1B093A052D76BECFFDE8435EAC114CF2133346B4D691F3F2068C957", providers: [
    { label: "public-fallback-a", lcd: "https://rest.cosmos.directory/cosmoshub", rpc: "https://rpc.cosmos.directory/cosmoshub" },
    { label: "public-fallback-b", lcd: "https://cosmos-rest.publicnode.com", rpc: "https://cosmos-rpc.publicnode.com" },
  ] },
  { key: "babylonGenesis", name: "Babylon Genesis", chainId: "bbn-1", denom: "ibc/89EE10FCF78800B572BAAC7080AEFA301B5F3BBC51C5371E907EB129C5B900E7", providers: [
    { label: "public-fallback-a", lcd: "https://babylon.nodes.guru/api", rpc: "https://babylon.nodes.guru/rpc" },
    { label: "public-fallback-b", lcd: "https://babylon-api.polkachu.com", rpc: "https://babylon-rpc.polkachu.com" },
  ] },
];

const started = Date.now();
function sha256(x) { return crypto.createHash("sha256").update(x).digest("hex"); }
function stable(v) { if (Array.isArray(v)) return v.map(stable); if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v).sort()) o[k] = stable(v[k]); return o; } return v; }
function serialize(v) { return JSON.stringify(stable(v), null, 2) + "\n"; }
function uint(v) { const s = v === null || v === undefined ? "" : String(v); return /^\d+$/.test(s) ? s : null; }
function normalizeError(e) { const s = `${e?.name || ""} ${e?.message || e || ""}`.toLowerCase(); if (s.includes("wall-limit")) return "wall-time-limit"; if (s.includes("request-limit")) return "request-limit"; if (s.includes("abort") || s.includes("timeout")) return "timeout"; if (s.includes("size-limit")) return "response-size-limit"; if (s.includes("not-found")) return "not-found"; if (s.includes("http-status")) return "http-status"; if (s.includes("height-missing")) return "response-height-missing"; if (s.includes("height-mismatch")) return "response-height-mismatch"; if (s.includes("json")) return "invalid-json"; if (s.includes("identity")) return "network-identity-mismatch"; if (s.includes("cursor-loop")) return "pagination-cursor-loop"; if (s.includes("shape") || s.includes("schema")) return "validation-rejected"; return "transport-error"; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function budget(net) { if (net.requests >= MAX_REQUESTS) throw new Error("request-limit"); if (Date.now() - started >= WALL_MS) throw new Error("wall-limit"); }
function allowed(provider, url) { const s = String(url); return [provider.lcd, provider.rpc].some(base => s === base || s.startsWith(`${base}/`) || s.startsWith(`${base}?`)); }

async function getJson(provider, url, net, options = {}) {
  if (!allowed(provider, url) || new URL(url).protocol !== "https:") throw new Error("invalid-url");
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    budget(net); net.requests++; if (attempt) net.retries++;
    const ctrl = new AbortController(), remaining = Math.max(1, WALL_MS - (Date.now() - started)), timer = setTimeout(() => ctrl.abort(), Math.min(TIMEOUT_MS, remaining));
    try {
      const headers = { accept: "application/json" };
      if (options.height !== undefined) headers["x-cosmos-block-height"] = String(options.height);
      const response = await fetch(url, { method: "GET", headers, signal: ctrl.signal, redirect: "error" });
      if (response.status === 404) throw new Error("not-found");
      if (!response.ok) throw new Error("http-status");
      if (options.height !== undefined) {
        options.binding.requests++;
        const returned = uint(response.headers.get("x-cosmos-block-height"));
        if (returned === null) { options.binding.missing++; throw new Error("height-missing"); }
        if (returned !== String(options.height)) { options.binding.mismatched++; throw new Error("height-mismatch"); }
        options.binding.matching++;
      }
      const declared = Number(response.headers.get("content-length") || 0); if (declared > MAX_BYTES) { net.responseSizeBlocks++; throw new Error("size-limit"); }
      if (!response.body) throw new Error("transport-error");
      const reader = response.body.getReader(), chunks = []; let total = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_BYTES) { net.responseSizeBlocks++; await reader.cancel(); ctrl.abort(); throw new Error("size-limit"); } chunks.push(Buffer.from(value)); }
      const json = JSON.parse(Buffer.concat(chunks, total).toString("utf8")); net.successes++; return json;
    } catch (e) {
      last = e; net.failures++; const c = normalizeError(e); net.failureClasses[c] = (net.failureClasses[c] || 0) + 1;
      if (attempt === 0 && ["timeout", "transport-error"].includes(c)) { await sleep(300); continue; }
      break;
    } finally { clearTimeout(timer); }
  }
  const errorClass = normalizeError(last); throw Object.assign(new Error(errorClass), { errorClass });
}

function statusPoint(j) { return { chainId: j?.result?.node_info?.network || null, height: uint(j?.result?.sync_info?.latest_block_height), hash: j?.result?.sync_info?.latest_block_hash || null, time: j?.result?.sync_info?.latest_block_time || null, catchingUp: j?.result?.sync_info?.catching_up ?? null }; }
function blockPoint(j) { return { chainId: j?.result?.block?.header?.chain_id || null, height: uint(j?.result?.block?.header?.height), hash: j?.result?.block_id?.hash || null, time: j?.result?.block?.header?.time || null }; }
async function selectProvider(cfg, net, binding) {
  const failures = [];
  for (const provider of cfg.providers) {
    try {
      const s = statusPoint(await getJson(provider, `${provider.rpc}/status`, net));
      if (s.chainId !== cfg.chainId || !s.height || !s.hash) throw new Error("identity");
      const b = blockPoint(await getJson(provider, `${provider.rpc}/block?height=${s.height}`, net));
      if (b.chainId !== cfg.chainId || b.height !== s.height || b.hash !== s.hash) throw new Error("identity");
      const n = await getJson(provider, `${provider.lcd}/cosmos/base/tendermint/v1beta1/node_info`, net, { height: s.height, binding });
      if (n?.default_node_info?.network !== cfg.chainId) throw new Error("identity");
      return { provider, label: provider.label, tried: failures.length + 1, failures, point: { chainId: cfg.chainId, height: s.height, hash: s.hash, time: b.time || s.time, catchingUp: s.catchingUp } };
    } catch (e) { failures.push(e.errorClass || normalizeError(e)); }
  }
  return { provider: null, label: null, tried: cfg.providers.length, failures, point: null };
}

function traceRows(j) { const rows = j?.denom_traces || j?.denomTraces || j?.result?.denom_traces || j?.result?.denomTraces; return Array.isArray(rows) ? rows : null; }
function directTrace(j) { return j?.denom_trace || j?.denomTrace || j?.result?.denom_trace || j?.result?.denomTrace || null; }
function structuredRows(j) { const rows = j?.denoms ?? j?.result?.denoms; return Array.isArray(rows) ? rows : null; }
function directStructured(j) { return j?.denom ?? j?.result?.denom ?? null; }
function traceFields(t) { const pathValue = t?.path, base = t?.base_denom ?? t?.baseDenom; return typeof pathValue === "string" && typeof base === "string" ? { path: pathValue, baseDenom: base } : null; }
function validBaseDenom(base) { const bytes = typeof base === "string" ? Buffer.byteLength(base, "utf8") : 0; return typeof base === "string" && bytes >= 3 && bytes <= 128 && /^[A-Za-z0-9][A-Za-z0-9/:._-]*$/.test(base) && !/[\s\x00-\x1f\x7f]/.test(base); }
function safeIdentifier(value) { return typeof value === "string" && Buffer.byteLength(value, "utf8") >= 1 && Buffer.byteLength(value, "utf8") <= 128 && /^[A-Za-z0-9][A-Za-z0-9._+\-#\[\]<>]*$/.test(value) && !/[\s\x00-\x1f\x7f/]/.test(value); }
function verifyTrace(t, targetHash) {
  const f = traceFields(t); if (!f) return { status: "trace-schema-rejected", hashVerified: false };
  const grammarValid = /^(?:transfer\/channel-\d+)(?:\/transfer\/channel-\d+)*$/.test(f.path), baseValid = validBaseDenom(f.baseDenom);
  const computed = sha256(Buffer.from(`${f.path}/${f.baseDenom}`, "utf8")).toUpperCase(), hashVerified = grammarValid && baseValid && computed === targetHash;
  return { status: hashVerified ? "observed-hash-verified" : grammarValid && baseValid ? "hash-mismatch-rejected" : "grammar-unverified", representation: "legacy-denom-trace", hashVerified, path: f.path, pathSha256: sha256(Buffer.from(f.path)), pathLength: Buffer.byteLength(f.path), baseDenom: f.baseDenom, baseDenomSha256: sha256(Buffer.from(f.baseDenom)), baseDenomLength: Buffer.byteLength(f.baseDenom), computedHash: computed, expectedHash: targetHash, pathGrammarValid: grammarValid, baseDenomValid: baseValid, pathHops: grammarValid ? f.path.split("/").length / 2 : null, immediateSourcePort: grammarValid ? f.path.split("/")[0] : null, immediateSourceChannel: grammarValid ? f.path.split("/")[1] : null, observedPorts: grammarValid ? [...new Set(f.path.split("/").filter((_, i) => i % 2 === 0))] : [], transferPortExpected: grammarValid };
}
function verifyStructured(t, targetHash) {
  if (!t || typeof t !== "object" || Array.isArray(t) || typeof t.base !== "string" || !Array.isArray(t.trace)) return { status: "structured-denom-schema-rejected", hashVerified: false };
  const hops = [];
  for (const item of t.trace) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { status: "structured-denom-schema-rejected", hashVerified: false };
    const port = item.port_id ?? item.portId, channel = item.channel_id ?? item.channelId;
    if (typeof port !== "string" || typeof channel !== "string") return { status: "structured-denom-schema-rejected", hashVerified: false };
    hops.push({ port, channel });
  }
  const identifiersValid = hops.length > 0 && hops.every(x => safeIdentifier(x.port) && safeIdentifier(x.channel)), baseValid = validBaseDenom(t.base);
  const pathValue = hops.map(x => `${x.port}/${x.channel}`).join("/"), computed = sha256(Buffer.from(`${pathValue}/${t.base}`, "utf8")).toUpperCase(), hashVerified = identifiersValid && baseValid && computed === targetHash;
  return { status: hashVerified ? "observed-hash-verified" : identifiersValid && baseValid ? "hash-mismatch-rejected" : "grammar-unverified", representation: "ibc-go-v10-structured-denom", hashVerified, path: pathValue, pathSha256: sha256(Buffer.from(pathValue)), pathLength: Buffer.byteLength(pathValue), baseDenom: t.base, baseDenomSha256: sha256(Buffer.from(t.base)), baseDenomLength: Buffer.byteLength(t.base), computedHash: computed, expectedHash: targetHash, pathGrammarValid: identifiersValid, baseDenomValid: baseValid, pathHops: identifiersValid ? hops.length : null, immediateSourcePort: identifiersValid ? hops[0].port : null, immediateSourceChannel: identifiersValid ? hops[0].channel : null, observedPorts: [...new Set(hops.map(x => x.port))], transferPortExpected: identifiersValid ? hops.every(x => x.port === "transfer") : null };
}
function pagination(j) { const p = j?.pagination || j?.result?.pagination || {}; return { nextKey: p.next_key || p.nextKey || null, total: uint(p.total) }; }
function totalStatus(first, later, firstRows, rows) {
  if (first !== null && BigInt(first) < BigInt(firstRows)) return "first-page-impossible-total";
  let expectedZero = false;
  for (const total of later) { if (total === "0" && first !== "0") expectedZero = true; else if (total !== null && first !== null && total !== first) return "changed"; else if (total === null) return first === null ? "missing-first-and-later-page-total" : "missing-later-page-total"; }
  if (first === null) return "missing-first-page-total";
  if (expectedZero) return "expected-zero-key-pagination";
  return BigInt(first) === BigInt(rows) ? "consistent" : "first-page-total-row-count-mismatch";
}
function pagedUrl(provider, route, cursor) { const u = new URL(provider.lcd + route); u.searchParams.set("pagination.limit", String(PAGE_LIMIT)); u.searchParams.set("pagination.count_total", "true"); if (cursor) u.searchParams.set("pagination.key", cursor); return u.toString(); }
async function paginateTraces(provider, route, targetHash, height, binding, net, structured = false) {
  let cursor = null, firstTotal = null, firstRows = 0, rows = 0, pages = 0, found = null, truncated = false, errorClass = null; const later = [], seen = new Set();
  for (let page = 1; page <= MAX_TRACE_PAGES; page++) {
    let j; try { j = await getJson(provider, pagedUrl(provider, route, cursor), net, { height, binding }); } catch (e) { errorClass = e.errorClass; truncated = true; break; }
    const list = structured ? structuredRows(j) : traceRows(j); if (!list) { errorClass = "validation-rejected"; truncated = true; break; }
    pages++; rows += list.length; const p = pagination(j); if (page === 1) { firstTotal = p.total; firstRows = list.length; } else later.push(p.total);
    for (const row of list) { const v = structured ? verifyStructured(row, targetHash) : verifyTrace(row, targetHash); if (v.hashVerified) found = v; }
    cursor = p.nextKey; if (!cursor) break; if (seen.has(cursor)) { errorClass = "pagination-cursor-loop"; truncated = true; break; } seen.add(cursor); if (page === MAX_TRACE_PAGES) truncated = true;
  }
  const totals = totalStatus(firstTotal, later, firstRows, rows), totalOk = ["consistent", "expected-zero-key-pagination"].includes(totals);
  if (!totalOk) truncated = true;
  return { pages, rows, advertisedTotal: firstTotal, laterPageTotalStatus: totals, truncated, complete: !truncated, errorClass, found };
}

async function resolveCounterparty(provider, trace, height, binding, net) {
  const out = { status: "not-attempted", localPort: trace.immediateSourcePort, localChannel: trace.immediateSourceChannel, counterpartyChannel: null, connectionId: null, clientId: null, chainId: null };
  try {
    const c = await getJson(provider, `${provider.lcd}/ibc/core/channel/v1/channels/${encodeURIComponent(trace.immediateSourceChannel)}/ports/${encodeURIComponent(trace.immediateSourcePort)}`, net, { height, binding });
    const channel = c?.channel; const connectionId = Array.isArray(channel?.connection_hops) ? channel.connection_hops[0] : null;
    if (!connectionId) throw new Error("channel-shape"); out.counterpartyChannel = channel?.counterparty?.channel_id || null; out.connectionId = connectionId;
    const connection = await getJson(provider, `${provider.lcd}/ibc/core/connection/v1/connections/${encodeURIComponent(connectionId)}`, net, { height, binding });
    const clientId = connection?.connection?.client_id; if (!clientId) throw new Error("connection-shape"); out.clientId = clientId;
    const client = await getJson(provider, `${provider.lcd}/ibc/core/client/v1/client_states/${encodeURIComponent(clientId)}`, net, { height, binding });
    const chainId = client?.identified_client_state?.client_state?.chain_id ?? client?.identifiedClientState?.clientState?.chainId;
    if (typeof chainId !== "string" || !chainId) throw new Error("client-shape"); out.chainId = chainId; out.status = "verified-at-pinned-height";
  } catch (e) { out.status = "unverified-query-or-shape-failure"; out.chainId = null; }
  return out;
}

async function scanChain(cfg) {
  const net = { requests: 0, successes: 0, failures: 0, retries: 0, responseSizeBlocks: 0, failureClasses: {} }, binding = { requests: 0, matching: 0, missing: 0, mismatched: 0 };
  const selected = await selectProvider(cfg, net, binding), targetHash = cfg.denom.slice(4);
  const out = { name: cfg.name, expectedChainId: cfg.chainId, providerLabel: selected.label, providersTried: selected.tried, providerFailureClasses: selected.failures, requests: net, fixedPoint: selected.point, binding: null, denom: cfg.denom, decimals: "unknown", supply: { status: "not-run", amount: null }, directTraceRoutes: [], allTraceRoutes: [], trace: { status: "coverage-unavailable", hashVerified: false }, counterparty: { status: "not-attempted", chainId: null }, bridgeMode: { status: "unresolved-no-route-evidence" }, metrics: null, blockers: [] };
  if (!selected.provider) { out.binding = { status: "unbound", ...binding }; out.blockers.push("public-fixed-point-provider-unresolved"); return finalizeChain(out, net, binding); }
  const p = selected.provider, h = selected.point.height;
  try {
    const j = await getJson(p, `${p.lcd}/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(cfg.denom)}`, net, { height: h, binding });
    const exact = j?.amount?.denom === cfg.denom, amount = uint(j?.amount?.amount); out.supply = exact && amount !== null ? { status: "observed-exact-denom", amount, returnedDenomExact: true, decimals: "unknown" } : { status: "rejected-denom-or-amount-mismatch", amount: null, returnedDenomExact: exact };
  } catch (e) { out.supply = { status: "unreadable", amount: null, errorClass: e.errorClass }; }
  const directRoutes = [
    { generation: "ibc-go-v10-transfer-v1", route: `/ibc/apps/transfer/v1/denoms/${targetHash}`, structured: true },
    { generation: "transfer-v1-denom-trace", route: `/ibc/apps/transfer/v1/denom_traces/${targetHash}`, structured: false },
    { generation: "legacy-transfer-v1beta1", route: `/ibc/applications/transfer/v1beta1/denom_traces/${targetHash}`, structured: false },
  ];
  let trace = null;
  for (const r of directRoutes) {
    if (trace) { out.directTraceRoutes.push({ generation: r.generation, status: "not-needed-earlier-route-verified" }); continue; }
    try { const j = await getJson(p, p.lcd + r.route, net, { height: h, binding }); const candidate = r.structured ? verifyStructured(directStructured(j), targetHash) : verifyTrace(directTrace(j), targetHash); out.directTraceRoutes.push({ generation: r.generation, status: candidate.status }); if (candidate.hashVerified) trace = candidate; }
    catch (e) { out.directTraceRoutes.push({ generation: r.generation, status: e.errorClass === "not-found" ? "not-found" : "unavailable-or-unbound" }); }
  }
  const allRoutes = [
    { generation: "ibc-go-v10-transfer-v1", route: "/ibc/apps/transfer/v1/denoms", structured: true },
    { generation: "transfer-v1-denom-trace", route: "/ibc/apps/transfer/v1/denom_traces", structured: false },
    { generation: "legacy-transfer-v1beta1", route: "/ibc/applications/transfer/v1beta1/denom_traces", structured: false },
  ];
  if (!trace) {
    for (const r of allRoutes) { const result = await paginateTraces(p, r.route, targetHash, h, binding, net, r.structured); out.allTraceRoutes.push({ generation: r.generation, pages: result.pages, rows: result.rows, advertisedTotal: result.advertisedTotal, laterPageTotalStatus: result.laterPageTotalStatus, truncated: result.truncated, complete: result.complete, status: result.errorClass ? "coverage-unavailable-or-incomplete" : "queried" }); if (!trace && result.found) trace = result.found; }
  } else for (const r of allRoutes) out.allTraceRoutes.push({ generation: r.generation, pages: 0, rows: 0, truncated: false, complete: false, status: "not-needed-direct-route-verified" });
  if (trace) { out.trace = trace; out.counterparty = await resolveCounterparty(p, trace, h, binding, net); }
  else if (out.allTraceRoutes.some(r => r.complete)) out.trace = { status: "not-found-after-complete-coverage", hashVerified: false };
  else out.trace = { status: "coverage-unavailable", hashVerified: false };
  const bound = binding.requests > 0 && binding.matching === binding.requests && binding.missing === 0 && binding.mismatched === 0;
  out.binding = { status: bound ? "bound" : "unbound", requestedHeight: h, ...binding };
  if (!bound) { out.supply = { status: "unbound-no-state-promotion", amount: null, decimals: "unknown" }; out.trace = { status: "unbound-no-state-promotion", hashVerified: false }; out.counterparty = { status: "unbound-no-state-promotion", chainId: null }; out.blockers.push("lcd-response-height-binding-incomplete"); }
  if (out.supply.status !== "observed-exact-denom") out.blockers.push("exact-denom-height-pinned-supply-unverified");
  if (!out.trace.hashVerified) out.blockers.push("ics20-trace-hash-and-grammar-unverified");
  if (out.counterparty.status !== "verified-at-pinned-height") out.blockers.push("counterparty-chain-id-unverified-no-source-chain-guess");
  out.blockers.push("ics20-source-escrow-burn-transit-and-in-flight-packet-reconciliation-absent", "remote-denom-to-evm-ibcvoucher-route-evidence-absent");
  return finalizeChain(out, net, binding);
}
function finalizeChain(out, net) {
  const allPages = out.allTraceRoutes.reduce((n, x) => n + (x.pages || 0), 0), allRows = out.allTraceRoutes.reduce((n, x) => n + (x.rows || 0), 0), allTruncated = out.allTraceRoutes.some(x => x.truncated);
  out.metrics = { requests: net.requests, successes: net.successes, failures: net.failures, retries: net.retries, fixedPointVerified: Boolean(out.fixedPoint), bindingStatus: out.binding?.status || "unbound", supplyStatus: out.supply.status, supplyAmount: out.supply.amount, directTraceRouteStatus: out.directTraceRoutes.map(x => `${x.generation}:${x.status}`).join(",") || "not-run", allTracePages: allPages, allTraceRows: allRows, allTraceTruncated: allTruncated, traceStatus: out.trace.status, traceHashVerified: out.trace.hashVerified === true, pathHops: out.trace.pathHops ?? null, counterpartyStatus: out.counterparty.status, counterpartyChainId: out.counterparty.status === "verified-at-pinned-height" ? out.counterparty.chainId : null, heightPinnedSupplyRows: out.binding?.status === "bound" && out.supply.status === "observed-exact-denom" ? 1 : 0, ics20TraceVerifiedRows: out.binding?.status === "bound" && out.trace.hashVerified ? 1 : 0, sourceChainVerifiedRows: out.binding?.status === "bound" && out.counterparty.status === "verified-at-pinned-height" ? 1 : 0, bridgeModeVerifiedRows: 0, fullyReconciledLiabilityRows: 0 };
  return out;
}

function localMode() {
  const repo = path.join(ROOT, "targets", "lombard-evm-smart-contracts"), source = path.join(repo, SOURCE_REL); let head = null, text = "", status = "unverified";
  try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim(); text = fs.readFileSync(source, "utf8"); const markers = /_lbtc\.burn\(/.test(text) && /_mint\(/.test(text) && /_burn\(/.test(text) && /\$\.lbtc\.mint\(/.test(text); if (head === COMMIT && markers) status = "source-verified-at-pinned-commit"; } catch (_) {}
  return { component: "IBCVoucher", checkoutCommitExpected: COMMIT, checkoutCommitObserved: head, sourcePath: `targets/lombard-evm-smart-contracts/${SOURCE_REL}`, sourceSha256: text ? sha256(Buffer.from(text)) : null, status, classification: "evm-intermediary-burn-mint-replacement", wrapFlow: "burn-LBTC/mint-voucher", spendFlow: "burn-voucher/mint-LBTC", ics20PacketImplementation: false, remoteIbcDenomDirectMintClaim: false, routeEvidenceStatus: "absent", caveat: "This EVM intermediary mode is separate from ICS-20 bank voucher accounting and is not linked to either remote denom without route evidence." };
}

function renderReport(raw) {
  const lines = ["# Lombard LBTC Step 12 — ICS-20 Origin and Bridge Mode", "", `**Classification:** ${raw.classification}`, "", "> Hardcoded public read-only Cosmos Hub and Babylon fallbacks only. Generic labels are retained; no endpoint URLs, domains, raw errors, response bodies, private inventories, secrets, keys, transactions, signing, wallets, mutations, forks, deployments, or aggregate promotion.", ""];
  for (const c of raw.chains) lines.push(`## ${c.name}`, `- Fixed point: chain=${c.fixedPoint?.chainId ?? "unresolved"}; height=${c.fixedPoint?.height ?? "unresolved"}; hash=${c.fixedPoint?.hash ?? "unresolved"}; time=${c.fixedPoint?.time ?? "unresolved"}; binding=${c.binding.status} (${c.binding.matching}/${c.binding.requests}).`, `- Supply: ${c.supply.status}; raw amount=${c.supply.amount ?? "null"}; decimals=unknown; exact denom required.`, `- Direct trace routes: ${c.metrics.directTraceRouteStatus}; all-trace pages/rows/truncated=${c.metrics.allTracePages}/${c.metrics.allTraceRows}/${c.metrics.allTraceTruncated}.`, `- Trace: ${c.trace.status}; hash verified=${c.trace.hashVerified}; path=${c.trace.path ?? "null"}; base_denom=${c.trace.baseDenom ?? "null"}; hops=${c.trace.pathHops ?? "null"}; immediate source channel=${c.trace.immediateSourceChannel ?? "null"}.`, `- Counterparty: ${c.counterparty.status}; chain=${c.metrics.counterpartyChainId ?? "unknown-no-guess"}.`, `- Rows: heightPinnedSupply=${c.metrics.heightPinnedSupplyRows}; ics20TraceVerified=${c.metrics.ics20TraceVerifiedRows}; sourceChainVerified=${c.metrics.sourceChainVerifiedRows}; bridgeModeVerified=${c.metrics.bridgeModeVerifiedRows}; fullyReconciledLiability=0.`, "");
  lines.push("## Mode separation", `- Local IBCVoucher: ${raw.localEvmMode.classification}; source status=${raw.localEvmMode.status}; localEvmModeSourceVerifiedRows=${raw.aggregateMetrics.localEvmModeSourceVerifiedRows}; aggregate bridgeModeVerifiedRows=${raw.aggregateMetrics.bridgeModeVerifiedRows}.`, "- It burns LBTC/mints voucher on wrap and burns voucher/mints LBTC on spend. It is not an ICS-20 packet implementation and is not asserted to mint either remote IBC denom without route evidence.", "- ICS-20 bank voucher accounting still requires source escrow/burn/transit/in-flight reconciliation. No naive addition or aggregate promotion was performed.", "", "## Closed gates", "`routePositive=0`, `routeEvidenceStatus=unknown`, `evidenceComplete=false`, `closureEligible=false`, `executableNow=0`, `signedActionJustified=false`, `forkJustified=false`.", ""); return lines.join("\n");
}
function renderHandoff(raw) { const rows = raw.chains.map(c => `- ${c.name}: binding=${c.binding.status}; supply=${c.supply.status}/${c.supply.amount ?? "null"}; trace=${c.trace.status}; hops=${c.trace.pathHops ?? "null"}; counterparty=${c.metrics.counterpartyChainId ?? "unknown-no-guess"}; rows(supply/trace/source/mode/reconciled)=${c.metrics.heightPinnedSupplyRows}/${c.metrics.ics20TraceVerifiedRows}/${c.metrics.sourceChainVerifiedRows}/${c.metrics.bridgeModeVerifiedRows}/0.`); return ["# Coordinator Handoff — Lombard LBTC Step 12 — 2026-07-12", "", `- Classification: **${raw.classification}**`, ...rows, `- Local mode=${raw.localEvmMode.classification}; source=${raw.localEvmMode.status}; ICS-20 packet implementation=false; remote direct-mint claim=false.`, "- No aggregate promotion; source escrow/burn/transit/in-flight reconciliation remains absent.", "", "## Step 13", "Close non-EVM supply gaps with height-pinned exact-denom state, verified origins, bridge-mode joins, and non-overlapping escrow/burn/transit accounting before any aggregate promotion.", "", "## Closed gates", "`routePositive=0`, `routeEvidenceStatus=unknown`, `evidenceComplete=false`, `closureEligible=false`, `executableNow=0`, `signedActionJustified=false`, `forkJustified=false`.", ""].join("\n"); }
function atomic(rel, text) { const target = path.join(ROOT, rel), temp = `${target}.tmp-${process.pid}`; fs.writeFileSync(temp, text, "utf8"); fs.renameSync(temp, target); }

async function main() {
  const chains = []; for (const cfg of CHAINS) chains.push(await scanChain(cfg));
  const mode = localMode(), aggregate = { heightPinnedSupplyRows: chains.reduce((n, x) => n + x.metrics.heightPinnedSupplyRows, 0), ics20TraceVerifiedRows: chains.reduce((n, x) => n + x.metrics.ics20TraceVerifiedRows, 0), sourceChainVerifiedRows: chains.reduce((n, x) => n + x.metrics.sourceChainVerifiedRows, 0), bridgeModeVerifiedRows: 0, localEvmModeSourceVerifiedRows: mode.status === "source-verified-at-pinned-commit" ? 1 : 0, fullyReconciledLiabilityRows: 0 };
  const blockers = [...new Set(chains.flatMap(c => c.blockers.map(b => `${c.name}: ${b}`)).concat(["no-route-evidence-links-remote-ics20-vouchers-to-evm-ibcvoucher", "no-source-escrow-burn-transit-in-flight-or-liability-reconciliation", "non-evm-supply-gaps-remain-for-step13"]))].sort();
  const raw = { generatedAt: new Date().toISOString(), scanner: "tools/scan-lombard-lbtc-ibc-origin-mode.js", classification: CLASSIFICATION, limits: { responseSizeCapBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS, wallTimeoutMs: WALL_MS, requestCeilingPerChain: MAX_REQUESTS, pageLimit: PAGE_LIMIT, maxAllTracePagesPerRoute: MAX_TRACE_PAGES, retryMaximum: 1, sequentialRequests: true, atomicWrites: true }, chains, localEvmMode: mode, aggregateMetrics: aggregate, blockers, assertions: { exactDenomsRequired: true, lcdHeightHeaderSentOnAllRequests: true, responseHeightRequiredForStatePromotion: true, traceHashUppercaseSha256Verified: chains.every(c => !c.trace.hashVerified || c.trace.computedHash === c.denom.slice(4)), tracePathGrammarRequired: true, noSourceChainGuess: chains.every(c => c.counterparty.status === "verified-at-pinned-height" || c.metrics.counterpartyChainId === null), evmModeSeparateFromIcs20: true, noNaiveAddition: true, noAggregatePromotion: true, noExploitClaim: true, noInsolvencyClaim: true, noPermissionlessViolationClaim: true }, conclusion: { exploitProven: false, insolvencyProven: false, permissionlessInvariantViolationProven: false, aggregatePromotion: false, fullyReconciledLiabilityRows: 0 }, gates: { routePositive: 0, routeEvidenceStatus: "unknown", evidenceComplete: false, closureEligible: false, executableNow: 0, signedActionJustified: false, forkJustified: false }, safety: { privateEndpointInventoryRead: false, envFilesRead: false, secretsRead: false, keysRead: false, transactions: false, signing: false, wallets: false, mutations: false, forks: false, deployments: false } };
  const rawText = serialize(raw), reportText = renderReport(raw), handoffText = renderHandoff(raw), outputs = [["raw", rawText], ["report", reportText], ["handoff", handoffText]];
  const endpoints = CHAINS.flatMap(c => c.providers.flatMap(p => [p.lcd, p.rpc])), forbidden = [...endpoints, ...endpoints.map(x => new URL(x).hostname), "publicnode", "polkachu", "nodes.guru", "cosmos.directory", "rawError", "responseBody", "requestHeaders"];
  for (const [name, text] of outputs) if (forbidden.some(x => text.toLowerCase().includes(x.toLowerCase()))) throw new Error(`${name}-output-leak`);
  if (chains.some(c => c.binding.status !== "bound" && (c.supply.amount !== null || c.trace.hashVerified || c.metrics.counterpartyChainId !== null))) throw new Error("binding-self-check");
  if (aggregate.fullyReconciledLiabilityRows !== 0 || raw.conclusion.aggregatePromotion || Object.values(raw.gates).some((v, i) => i === 1 ? v !== "unknown" : Boolean(v))) throw new Error("gate-self-check");
  if (mode.ics20PacketImplementation || mode.remoteIbcDenomDirectMintClaim) throw new Error("mode-self-check");
  atomic(RAW_REL, rawText); atomic(REPORT_REL, reportText); atomic(HANDOFF_REL, handoffText);
  const cm = chains.map(c => `${c.name.replaceAll(" ", "_")}{binding=${c.binding.status},height=${c.fixedPoint?.height ?? "null"},supply=${c.supply.status}:${c.supply.amount ?? "null"},trace=${c.trace.status},hops=${c.trace.pathHops ?? "null"},counterparty=${c.metrics.counterpartyChainId ?? "unknown"},modeRows=${c.metrics.bridgeModeVerifiedRows},rows=${c.metrics.heightPinnedSupplyRows}/${c.metrics.ics20TraceVerifiedRows}/${c.metrics.sourceChainVerifiedRows}/${c.metrics.fullyReconciledLiabilityRows}}`).join(" ");
  process.stdout.write(`rawSha256=${sha256(rawText)} reportSha256=${sha256(reportText)} handoffSha256=${sha256(handoffText)} scannerSha256=${sha256(fs.readFileSync(__filename))} ${cm} localMode=${mode.classification}:${mode.status} aggregateRows=${aggregate.heightPinnedSupplyRows}/${aggregate.ics20TraceVerifiedRows}/${aggregate.sourceChainVerifiedRows}/${aggregate.bridgeModeVerifiedRows}/${aggregate.fullyReconciledLiabilityRows} localEvmModeSourceVerifiedRows=${aggregate.localEvmModeSourceVerifiedRows} blockers=${blockers.length} assertions=passed leakCheck=passed\n`);
}

main().catch(e => { const safe = /^(?:raw|report|handoff)-output-leak$|^(?:binding|gate|mode)-self-check$/.test(e?.message || "") ? e.message : normalizeError(e); process.stderr.write(`scan-lombard-lbtc-ibc-origin-mode failed: ${safe}\n`); process.exitCode = 1; });
