#!/usr/bin/env node
// test-sui-endpoints.js - sanitized Sui endpoint usability probe.
// Reads endpoint inventories but never prints or stores URLs, keys, or domains.

const fs = require("fs");
const path = require("path");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT = path.join(WORKSPACE, "reports", "raw", "fast", "sui-endpoint-usability.json");
const RPC_FILE = path.join(WORKSPACE, "rpc_endpoints.txt");
const GRAPHQL_FILE = path.join(WORKSPACE, "graphql_endpoints.txt");
const PROBE_OBJECT_ID = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const QUIET = process.argv.includes("--quiet");

function readText(file) {
  try { return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""; } catch (_) { return ""; }
}

function classifySource(file) {
  return path.basename(file).replace(/_endpoints\.txt$/i, "");
}

function collectCandidates(file) {
  const source = classifySource(file);
  const text = readText(file);
  const rows = [];
  let suiWindow = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/sui/i.test(line)) suiWindow = 6;
    const urls = [...line.matchAll(/https?:\/\/[^\s'"<>]+/g)].map((match) => match[0].replace(/[),;]+$/, ""));
    const lineLooksSui = /sui/i.test(line) || suiWindow > 0 || urls.some((url) => /sui/i.test(url));
    if (lineLooksSui) {
      for (const url of urls) rows.push({ source, line: i + 1, url });
    }
    if (suiWindow > 0) suiWindow -= 1;
  }
  return rows;
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const row of candidates) {
    if (!row.url || seen.has(row.url)) continue;
    seen.add(row.url);
    out.push(row);
  }
  return out;
}

async function postJson(url, body, timeoutMs = 9_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let json = null;
    try { json = await response.json(); } catch (_) {}
    return { ok: response.ok, status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

function errorClass(error) {
  const text = String(error?.name || error?.message || error || "unknown").toLowerCase();
  if (text.includes("abort") || text.includes("timeout")) return "timeout";
  if (text.includes("fetch") || text.includes("network")) return "network-error";
  return "request-error";
}

async function testJsonRpc(url) {
  try {
    const state = await postJson(url, { jsonrpc: "2.0", id: 1, method: "suix_getLatestSuiSystemState", params: [] });
    if (!state.ok) return { usable: false, errorClass: `http-${state.status}` };
    if (state.json?.error) return { usable: false, errorClass: "jsonrpc-error" };
    const epoch = state.json?.result?.epoch || null;
    if (!epoch) return { usable: false, errorClass: "missing-epoch" };
    const object = await postJson(url, {
      jsonrpc: "2.0",
      id: 2,
      method: "sui_getObject",
      params: [PROBE_OBJECT_ID, { showType: true }],
    });
    if (!object.ok) return { usable: false, epoch, errorClass: `http-${object.status}` };
    if (object.json?.error) return { usable: false, epoch, errorClass: "object-method-error" };
    return { usable: Boolean(object.json?.result?.data?.type), epoch, objectProbe: Boolean(object.json?.result?.data?.type) };
  } catch (error) {
    return { usable: false, errorClass: errorClass(error) };
  }
}

async function testGraphql(url) {
  try {
    const schema = await postJson(url, { query: "query { __schema { queryType { fields { name } } } }" });
    if (!schema.ok) return { usable: false, errorClass: `http-${schema.status}` };
    if (!schema.json || schema.json.errors) return { usable: false, errorClass: schema.json ? "graphql-error" : "non-json-response" };
    const fields = schema.json?.data?.__schema?.queryType?.fields?.map((field) => field.name) || [];
    const suiLike = fields.some((field) => /epoch|checkpoint|object|address|chainIdentifier/i.test(field));
    return { usable: suiLike, suiLike, queryFieldCount: fields.length };
  } catch (error) {
    return { usable: false, errorClass: errorClass(error) };
  }
}

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const candidates = uniqueCandidates([
    ...collectCandidates(RPC_FILE),
    ...collectCandidates(GRAPHQL_FILE),
  ]);
  const results = [];
  let index = 0;
  for (const candidate of candidates) {
    index += 1;
    const jsonRpc = await testJsonRpc(candidate.url);
    const graphql = await testGraphql(candidate.url);
    results.push({
      id: `sui-endpoint-${index}`,
      source: candidate.source,
      sourceLine: candidate.line,
      jsonRpcUsable: Boolean(jsonRpc.usable),
      jsonRpcEpoch: jsonRpc.epoch || null,
      jsonRpcObjectProbe: Boolean(jsonRpc.objectProbe),
      jsonRpcErrorClass: jsonRpc.usable ? null : jsonRpc.errorClass || "unknown",
      graphqlUsable: Boolean(graphql.usable),
      graphqlSuiLike: Boolean(graphql.suiLike),
      graphqlQueryFieldCount: graphql.queryFieldCount || 0,
      graphqlErrorClass: graphql.usable ? null : graphql.errorClass || "unknown",
    });
  }
  const summary = {
    candidatesTested: results.length,
    jsonRpcUsable: results.filter((row) => row.jsonRpcUsable).length,
    graphqlUsable: results.filter((row) => row.graphqlUsable).length,
    dualUsable: results.filter((row) => row.jsonRpcUsable && row.graphqlUsable).length,
    sources: Object.fromEntries([...new Set(results.map((row) => row.source))].map((source) => [source, results.filter((row) => row.source === source).length])),
    rpcUrlsStored: false,
    rawUrlsPrinted: false,
  };
  const artifact = {
    generatedAt: new Date().toISOString(),
    scanner: "tools/test-sui-endpoints.js",
    scope: "Sanitized Sui endpoint usability test over rpc_endpoints.txt and graphql_endpoints.txt",
    safety: {
      endpointInventoriesRead: true,
      rpcUrlsStored: false,
      rawUrlsPrinted: false,
      privateKeysRead: false,
      signedActions: false,
      exploitExecuteCalls: false,
    },
    summary,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2) + "\n");
  if (!QUIET) {
    console.log(`Sui endpoint usability: tested=${summary.candidatesTested} jsonRpcUsable=${summary.jsonRpcUsable} graphqlUsable=${summary.graphqlUsable} dualUsable=${summary.dualUsable}`);
  }
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
