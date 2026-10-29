#!/usr/bin/env node
// test-thorchain-endpoints-sanitized.js - Thorchain inbound endpoint usability probe.
// Reads rpc_endpoints.txt in memory only. Never prints URLs, hosts, headers, keys, or response bodies.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const URL_RE = /(https?:\/\/[^\s'"<>\[\]]+)/g;
const ORIGIN_RE = /\[origin:\s*([^\]\s]+)\]/i;
const HEADER_RE = /\[header:\s*([^=\]\s]+)=([^\]]+)\]/gi;
const THORCHAIN_HINT_RE = /(thorchain|thornode|midgard|nine\s*realms|ninerealms)/i;
const EVM_CHAINS = new Set(["ETH", "BSC", "BNB", "AVAX", "BASE"]);

function readRows() {
  if (!fs.existsSync(RPC_FILE)) return [];
  const rows = [];
  const lines = fs.readFileSync(RPC_FILE, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!THORCHAIN_HINT_RE.test(line)) continue;
    const origin = line.match(ORIGIN_RE)?.[1] || null;
    const extraHeaders = {};
    for (const h of line.matchAll(HEADER_RE)) extraHeaders[h[1].toLowerCase()] = h[2];
    for (const m of line.matchAll(URL_RE)) rows.push({ url: m[1].replace(/[)\],]+$/g, ""), origin, extraHeaders });
  }
  return rows;
}

function headersFor(row) {
  const headers = { "user-agent": "evm-audit-thorchain-endpoint-test/1.0" };
  if (row.origin) headers.origin = row.origin;
  for (const [key, value] of Object.entries(row.extraHeaders || {})) headers[key] = value;
  return headers;
}

function withPath(raw, suffix) {
  try {
    const u = new URL(raw);
    const basePath = u.pathname.replace(/\/+$/g, "");
    u.pathname = `${basePath}${suffix}`.replace(/\/+/g, "/");
    return u.toString();
  } catch (_) { return null; }
}

function candidateUrls(raw) {
  const out = [];
  try {
    const u = new URL(raw);
    const pathName = u.pathname.replace(/\/+$/g, "");
    if (/\/thorchain\/inbound_addresses$/i.test(pathName)) out.push(u.toString());
    if (/\/thorchain$/i.test(pathName)) out.push(withPath(raw, "/inbound_addresses"));
    else out.push(withPath(raw, "/thorchain/inbound_addresses"));
    if (!/\/lcd(\/|$)/i.test(pathName)) out.push(withPath(raw, "/lcd/thorchain/inbound_addresses"));
  } catch (_) {}
  return [...new Set(out.filter(Boolean))].slice(0, 3);
}

function inboundRows(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.inbound_addresses)) return json.inbound_addresses;
  if (Array.isArray(json?.result)) return json.result;
  if (Array.isArray(json?.data)) return json.data;
  return [];
}

async function fetchJson(url, headers, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    let json = null;
    try { json = JSON.parse(await res.text()); } catch (_) { json = null; }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, error: err?.name === "AbortError" ? "timeout" : "network" };
  } finally { clearTimeout(timer); }
}

async function main() {
  const rows = readRows();
  const seen = new Set();
  const out = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/test-thorchain-endpoints-sanitized.js",
    safety: { rpcInventoryRead: true, rpcUrlsStored: false, hostsPrinted: false, headersPrinted: false, responseBodiesPrinted: false, privateKeysRead: false, signedActions: false },
    endpointRowsWithThorchainHint: rows.length,
    candidateUrlsTested: 0,
    usableEndpointRows: 0,
    successfulCandidates: 0,
    authOrForbidden: 0,
    notFound: 0,
    noJsonOrNoRows: 0,
    timeoutOrNetwork: 0,
    inboundRows: 0,
    evmInboundRows: 0,
    rowsWithRouter: 0,
    rowsWithVaultAddress: 0,
    chainCounts: {},
    evmChainCounts: {},
  };
  for (const row of rows) {
    const candidates = candidateUrls(row.url).filter((url) => {
      const key = `${url}|${Boolean(row.origin)}|${Object.keys(row.extraHeaders || {}).sort().join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    let rowUsable = false;
    for (const url of candidates) {
      out.candidateUrlsTested += 1;
      const res = await fetchJson(url, headersFor(row));
      if (res.status === 0) { out.timeoutOrNetwork += 1; continue; }
      if (res.status === 401 || res.status === 403) { out.authOrForbidden += 1; continue; }
      if (res.status === 404) { out.notFound += 1; continue; }
      const arr = inboundRows(res.json);
      if (!arr.length) { out.noJsonOrNoRows += 1; continue; }
      out.successfulCandidates += 1;
      rowUsable = true;
      out.inboundRows += arr.length;
      for (const item of arr) {
        const chain = String(item?.chain || "unknown").toUpperCase();
        out.chainCounts[chain] = (out.chainCounts[chain] || 0) + 1;
        if (EVM_CHAINS.has(chain)) {
          out.evmInboundRows += 1;
          out.evmChainCounts[chain] = (out.evmChainCounts[chain] || 0) + 1;
          if (item?.router) out.rowsWithRouter += 1;
          if (item?.address) out.rowsWithVaultAddress += 1;
        }
      }
    }
    if (rowUsable) out.usableEndpointRows += 1;
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => { console.error(err?.message || String(err)); process.exit(1); });
