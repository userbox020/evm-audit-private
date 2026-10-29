#!/usr/bin/env node
"use strict";

// Keyless historical fork runner. Upstream inventory material remains in this
// parent process; Forge receives only an ephemeral localhost read-only relay.
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const INVENTORY = path.join(ROOT, "rpc_endpoints.txt");
const HARNESS = path.join(ROOT, "harnesses", "gamma-hypervisor-ordinary-spot-manipulation-r1");
const RAW = path.join(ROOT, "reports", "raw", "fast", "gamma-hypervisor-ordinary-spot-manipulation-fork-r1");
const JSON_OUT = path.join(ROOT, "reports", "gamma-hypervisor-ordinary-spot-manipulation-fork-r1.json");
const MD_OUT = path.join(ROOT, "reports", "gamma-hypervisor-ordinary-spot-manipulation-fork-r1.md");
const BLOCK = 25780180n;
const BLOCK_HEX = `0x${BLOCK.toString(16)}`;
const EXPECTED_HASH = "0x8587566ef1282febc9c99f87b12b4189a646f0589528ce5e51897290fd0893db";
const CHAIN = 1n;
const TEST = "GammaOrdinarySpotManipulationR1Test";
const Q192 = 2n ** 192n;
const WAD = 10n ** 18n;
const START_LQTY = 1_000_000n * WAD;
const START_WETH = 500n * WAD;
const ETH_USD_FEED = "0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419";
const ALLOWED = new Set(["eth_chainId", "net_version", "web3_clientVersion", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getCode", "eth_getStorageAt", "eth_getBalance", "eth_getTransactionCount", "eth_call", "eth_getProof", "eth_getLogs", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_feeHistory", "eth_gasPrice", "eth_maxPriorityFeePerGas"]);
const CAPS = Object.freeze({ inventoryBytes: 1048576, candidates: 64, families: 32, calls: 16000, requestBytes: 2097152, responseBytes: 8388608, totalBytes: 384 * 1024 * 1024, requestMs: 20000, forgeMs: 900000 });

function sha(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function parseInventory(text) {
  if (Buffer.byteLength(text) > CAPS.inventoryBytes) throw new Error("inventory cap");
  const rows = [], seen = new Set(), lines = text.split(/\r?\n/u);
  for (let i = 0; i < lines.length; i++) for (const match of lines[i].matchAll(/https:\/\/[^\s<'"`\])}]+/giu)) {
    let url; try { url = new URL(match[0].replace(/[>,.;]+$/u, "")); } catch (_) { continue; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) continue;
    const headers = {}; for (const h of lines[i].matchAll(/\[header:\s*([^=\]\s]+)=([^\]]+)\]/giu)) headers[h[1].trim()] = h[2].trim();
    const key = `${url.href}\0${JSON.stringify(headers)}`; if (seen.has(key)) continue; seen.add(key);
    const context = lines.slice(Math.max(0, i - 3), i + 4).join(" ");
    rows.push({ url, headers, family: url.hostname.toLowerCase(), hint: /(?:ethereum|eth-mainnet|chain(?:id)?[^a-z0-9]{0,8}(?:1|0x1))(?!\d)/iu.test(context) });
  }
  return rows.sort((a, b) => Number(b.hint) - Number(a.hint)).slice(0, CAPS.candidates);
}
function secretCorpus(rows) { const out = new Set(); for (const row of rows) for (const x of [row.url.href, ...row.url.pathname.split("/"), ...row.url.searchParams.values(), ...Object.values(row.headers)]) if (String(x).length >= 16) { out.add(String(x)); out.add(String(x).toLowerCase()); } return [...out]; }
function guard(value, secrets) { const text = JSON.stringify(value), low = text.toLowerCase(); if (/(?:https?|wss?):\/\//iu.test(text) || /"(?:endpoint|provider|hostname|domain|headers?)"\s*:/iu.test(text)) throw new Error("secret shape in output"); for (const secret of secrets) if (text.includes(secret) || low.includes(secret.toLowerCase())) throw new Error("inventory material in output"); }
class Budget { constructor() { this.calls = 0; this.bytes = 0; } use() { if (++this.calls > CAPS.calls) throw new Error("RPC call cap"); } add(n) { this.bytes += n; if (n > CAPS.responseBytes || this.bytes > CAPS.totalBytes) throw new Error("RPC response cap"); } }
async function upstream(ep, payload, budget) {
  budget.use(); const body = Buffer.from(JSON.stringify(payload)); if (body.length > CAPS.requestBytes) throw new Error("RPC request cap");
  return new Promise((resolve) => { let done = false, req; const finish = (x) => { if (done) return; done = true; clearTimeout(timer); try { req?.destroy(); } catch (_) {} resolve(x); };
    const timer = setTimeout(() => finish({ ok: false, reason: "TIMEOUT" }), CAPS.requestMs), options = { protocol: "https:", hostname: ep.url.hostname, port: ep.url.port || 443, path: `${ep.url.pathname}${ep.url.search}`, method: "POST", agent: false, headers: { ...ep.headers, "content-type": "application/json", accept: "application/json", "accept-encoding": "identity", "content-length": body.length } };
    try { req = https.request(options, (res) => { const chunks = []; let size = 0; res.on("data", (c) => { size += c.length; if (size > CAPS.responseBytes) finish({ ok: false, reason: "RESPONSE_CAP" }); else chunks.push(Buffer.from(c)); }); res.on("end", () => { if (done) return; try { budget.add(size); } catch (e) { return finish({ ok: false, reason: e.message }); } if (res.statusCode !== 200) return finish({ ok: false, reason: "HTTP_STATUS" }); try { finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (_) { finish({ ok: false, reason: "INVALID_JSON" }); } }); }); req.on("error", () => finish({ ok: false, reason: "TRANSPORT_ERROR" })); req.end(body); } catch (_) { finish({ ok: false, reason: "TRANSPORT_ERROR" }); }
  });
}
async function rpc(ep, method, params, budget) { const row = await upstream(ep, { jsonrpc: "2.0", id: budget.calls + 1, method, params }, budget); if (!row.ok || row.value?.error) return { ok: false, reason: row.reason || "RPC_ERROR" }; return { ok: true, result: row.value.result }; }
async function qualify(rows, budget) {
  const seen = new Set(), capable = []; let tested = 0;
  for (const ep of rows) {
    if (seen.has(ep.family) || tested >= CAPS.families) continue; seen.add(ep.family); tested++;
    const chain = await rpc(ep, "eth_chainId", [], budget); if (!chain.ok) continue; try { if (BigInt(chain.result) !== CHAIN) continue; } catch (_) { continue; }
    const block = await rpc(ep, "eth_getBlockByNumber", [BLOCK_HEX, false], budget); if (!block.ok || block.result?.hash?.toLowerCase() !== EXPECTED_HASH) continue;
    const code = await rpc(ep, "eth_getCode", ["0xd5f4877263b736625ba363385983c2d02b41f35b", BLOCK_HEX], budget); if (!code.ok || code.result === "0x") continue;
    const storage = await rpc(ep, "eth_getStorageAt", ["0xd5f4877263b736625ba363385983c2d02b41f35b", "0x0", BLOCK_HEX], budget); if (!storage.ok) continue;
    capable.push({ ep, pin: { number: BLOCK.toString(), hash: EXPECTED_HASH, timestamp: BigInt(block.result.timestamp).toString(), baseFeePerGas: BigInt(block.result.baseFeePerGas || "0x0").toString() } });
    if (capable.length >= 2) break;
  }
  return { tested, capable, selected: capable[0] || null };
}
function pinnedPayload(payload) {
  const list = Array.isArray(payload) ? payload : [payload];
  return list.map((item) => {
    const x = { ...item, params: Array.isArray(item.params) ? [...item.params] : [] };
    const index = ({ eth_getBlockByNumber: 0, eth_getCode: 1, eth_getBalance: 1, eth_getTransactionCount: 1, eth_call: 1, eth_getProof: 2, eth_feeHistory: 1 })[x.method];
    if (index !== undefined && (x.params[index] === undefined || ["latest", "safe", "finalized", "pending"].includes(x.params[index]))) x.params[index] = BLOCK_HEX;
    if (x.method === "eth_getBlockByHash" && String(x.params[0]).toLowerCase() !== EXPECTED_HASH) throw new Error("non-pin block hash denied");
    if (x.method === "eth_getLogs" && x.params[0] && !x.params[0].blockHash) { x.params[0] = { ...x.params[0], fromBlock: x.params[0].fromBlock || "0x0", toBlock: BLOCK_HEX }; }
    return x;
  });
}
async function startRelay(ep, budget, pin) {
  const counts = {};
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    const chunks = []; let size = 0; req.on("data", (c) => { size += c.length; if (size <= CAPS.requestBytes) chunks.push(c); });
    req.on("end", async () => {
      if (size > CAPS.requestBytes) { res.writeHead(413); return res.end(); }
      let incoming, outgoing; try { incoming = JSON.parse(Buffer.concat(chunks).toString("utf8")); const list = Array.isArray(incoming) ? incoming : [incoming]; for (const item of list) { if (!ALLOWED.has(item?.method)) { const denied = typeof item?.method === "string" && /^[_a-zA-Z0-9]+$/u.test(item.method) ? item.method : "invalid"; counts[`denied_${denied}`] = (counts[`denied_${denied}`] || 0) + 1; throw new Error("method denied"); } counts[item.method] = (counts[item.method] || 0) + 1; } outgoing = pinnedPayload(incoming); } catch (_) { res.writeHead(403, { "content-type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "read-only pinned relay denied request" } })); }
      const list = Array.isArray(incoming) ? incoming : [incoming], synthetic = list.map((item) => item.method === "eth_gasPrice" ? { jsonrpc: "2.0", id: item.id, result: `0x${BigInt(pin.baseFeePerGas).toString(16)}` } : item.method === "eth_maxPriorityFeePerGas" ? { jsonrpc: "2.0", id: item.id, result: "0x0" } : null);
      if (synthetic.every(Boolean)) { const body = Buffer.from(JSON.stringify(Array.isArray(incoming) ? synthetic : synthetic[0])); res.writeHead(200, { "content-type": "application/json", "content-length": body.length }); return res.end(body); }
      const row = await upstream(ep, Array.isArray(incoming) ? outgoing : outgoing[0], budget); if (!row.ok) { res.writeHead(502, { "content-type": "application/json" }); return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "upstream read failed" } })); }
      const body = Buffer.from(JSON.stringify(row.value)); res.writeHead(200, { "content-type": "application/json", "content-length": body.length }); res.end(body);
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, port: server.address().port, counts };
}
function sanitizedEnv() { const out = {}; for (const [key, value] of Object.entries(process.env)) if (!/(?:RPC|ENDPOINT|PROVIDER|SECRET|TOKEN|API[_-]?KEY|PRIVATE|MNEMONIC|WALLET)/iu.test(key)) out[key] = value; return out; }
function parseMetrics(text) { const out = {}; for (const line of text.split(/\r?\n/u)) { const match = line.match(/R1_METRIC\s+([A-Za-z0-9_]+)\s*[: ]\s*(\d+)/u); if (match) out[match[1]] = (out[match[1]] || []).concat(match[2]); } return out; }
function runForge(port) { return new Promise((resolve) => { const args = ["test", "--match-contract", TEST, "--match-test", "testOrdinarySpotManipulationDifferentialR1", "--fork-url", `http://127.0.0.1:${port}`, "--fork-block-number", BLOCK.toString(), "-vvvv"], child = spawn("forge", args, { cwd: HARNESS, env: sanitizedEnv(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "", killed = false; const timer = setTimeout(() => { killed = true; child.kill(); }, CAPS.forgeMs); child.stdout.on("data", (c) => { stdout += c; }); child.stderr.on("data", (c) => { stderr += c; }); child.on("close", (exitCode) => { clearTimeout(timer); const all = `${stdout}\n${stderr}`; resolve({ exitCode, killed, metrics: parseMetrics(all), outputSha256: sha(Buffer.from(all)), summary: all.split(/\r?\n/u).slice(-160) }); }); }); }
function latest(metrics, key) { const values = metrics[key]; return values?.[values.length - 1] ?? null; }
function signed(value) { return BigInt(value || "0"); }
function mulDivSigned(value, numerator, denominator) { return value >= 0n ? value * numerator / denominator : -((-value) * numerator / denominator); }
function fixedSigned(value, decimals = 18) { const negative = value < 0n, absolute = negative ? -value : value, scale = 10n ** BigInt(decimals), whole = absolute / scale, fraction = (absolute % scale).toString().padStart(decimals, "0").replace(/0+$/u, ""); return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`; }
async function oraclePrice(ep, budget) {
  const round = await rpc(ep, "eth_call", [{ to: ETH_USD_FEED, data: "0xfeaf968c" }, BLOCK_HEX], budget), decimals = await rpc(ep, "eth_call", [{ to: ETH_USD_FEED, data: "0x313ce567" }, BLOCK_HEX], budget);
  if (!round.ok || !decimals.ok || !/^0x[0-9a-f]+$/iu.test(round.result || "") || round.result.length < 130) return null;
  const answer = BigInt(`0x${round.result.slice(66, 130)}`), d = Number(BigInt(decimals.result)); if (answer <= 0n || d > 36) return null;
  return { answer: answer.toString(), decimals: d, usdPerEthWad: (answer * 10n ** BigInt(18 - d)).toString() };
}
function economics(metrics, pin, ethUsd) {
  const sqrt = BigInt(latest(metrics, "originalSqrt") || "0"), lqtyWethWad = sqrt * sqrt * WAD / Q192, baseline0 = signed(latest(metrics, "baseline_final0")), baseline1 = signed(latest(metrics, "baseline_final1"));
  const rows = [];
  for (const branch of ["down", "up"]) {
    const final0 = signed(latest(metrics, `${branch}_final0`)), final1 = signed(latest(metrics, `${branch}_final1`)), delta0 = final0 - baseline0, delta1 = final1 - baseline1;
    const adversePrice = delta0 >= 0n ? lqtyWethWad * 9900n / 10000n : lqtyWethWad * 10100n / 10000n;
    const gross = delta1 + mulDivSigned(delta0, adversePrice, WAD);
    const deposit0 = signed(latest(metrics, `${branch}_deposit0`)), deposit1 = signed(latest(metrics, `${branch}_deposit1`)), boundary = signed(latest(metrics, `${branch}_boundaryPass`));
    const capital0 = branch === "down" ? deposit0 + boundary : deposit0 + 100_000n * WAD;
    const capital1 = branch === "down" ? deposit1 + 20n * WAD : deposit1 + boundary;
    const capitalWeth = capital1 + capital0 * lqtyWethWad / WAD;
    const financing = capitalWeth * 5n / 10000n;
    const gasUnits = signed(latest(metrics, `${branch}_gas`)), gasCost = gasUnits * BigInt(pin.baseFeePerGas);
    const net = gross - financing - gasCost, usd = ethUsd ? mulDivSigned(net, BigInt(ethUsd.usdPerEthWad), WAD) : null, bps = capitalWeth > 0n ? mulDivSigned(net, 10000n, capitalWeth) : null, bpsX18 = capitalWeth > 0n ? mulDivSigned(net, 10000n * WAD, capitalWeth) : null;
    const incumbent0 = signed(latest(metrics, `${branch}_incumbent0After`)) - signed(latest(metrics, `${branch}_incumbent0Before`));
    const incumbent1 = signed(latest(metrics, `${branch}_incumbent1After`)) - signed(latest(metrics, `${branch}_incumbent1Before`));
    const poolDelta0 = signed(latest(metrics, `${branch}_poolBalance0`)) - signed(latest(metrics, `${branch}_poolBalance0Before`)), poolDelta1 = signed(latest(metrics, `${branch}_poolBalance1`)) - signed(latest(metrics, `${branch}_poolBalance1Before`));
    rows.push({ branch, actorDeltaVsBaseline: { lqtyRaw: delta0.toString(), wethWei: delta1.toString(), conservativeWethWei: gross.toString() }, valuation: { lqtyWethPriceWad: lqtyWethWad.toString(), adversePriceWad: adversePrice.toString(), adverseHaircutBps: "100" }, obligations: { financingBpsOneDay: "5", financingWethWei: financing.toString(), fullRouteGasUnits: gasUnits.toString(), historicalBaseFeeWei: pin.baseFeePerGas, gasCostWei: gasCost.toString(), realizedPoolSlippageAndFeesIncludedInActorDelta: true }, attackerCapital: { lqtyRaw: capital0.toString(), wethWei: capital1.toString(), wethEquivalentWei: capitalWeth.toString() }, conservativeNet: { nativeWei: net.toString(), usdWad: usd?.toString() ?? null, bpsAttackerCapital: bps?.toString() ?? null, bpsAttackerCapitalX18: bpsX18?.toString() ?? null, bpsAttackerCapitalDecimal: bpsX18 === null ? null : fixedSigned(bpsX18), exactBpsRatio: capitalWeth > 0n ? { numerator: (net * 10000n).toString(), denominator: capitalWeth.toString() } : null }, incumbentNavDelta: { lqtyRaw: incumbent0.toString(), wethWei: incumbent1.toString(), valuedWethWei: (incumbent1 + mulDivSigned(incumbent0, lqtyWethWad, WAD)).toString() }, captures: { feeRecipientLqtyRaw: latest(metrics, `${branch}_feeRecipient0`), feeRecipientWethWei: latest(metrics, `${branch}_feeRecipient1`), poolProtocolLqtyRaw: latest(metrics, `${branch}_protocolFee0`), poolProtocolWethWei: latest(metrics, `${branch}_protocolFee1`), poolBalanceDeltaLqtyRaw: poolDelta0.toString(), poolBalanceDeltaWethWei: poolDelta1.toString() } });
  }
  return { token0PriceWethWad: lqtyWethWad.toString(), ethUsd, sameCapitalBaseline: { finalLqtyRaw: baseline0.toString(), finalWethWei: baseline1.toString(), gasUnits: latest(metrics, "baseline_gas") }, assumptions: { uncertaintyAdverseToken0ValuationBps: "100", financingBpsOneDay: "5", competitionAndLatency: "No positive capture credited; realized round-trip loss retained in full.", gasPricePolicy: "Pinned block baseFeePerGas times full attack-route gas units." }, rows };
}
function buildReport(run, pin, tested, capableCount, counts, budget, ethUsd) {
  const metrics = run.metrics, econ = economics(metrics, pin, ethUsd), required = ["baseline_final0", "baseline_final1", "down_final0", "down_final1", "up_final0", "up_final1", "down_boundaryPass", "down_boundaryFail", "up_boundaryPass", "up_boundaryFail", "originalSqrt", "actorFreeListed"];
  const complete = run.exitCode === 0 && !run.killed && required.every((key) => latest(metrics, key) !== null);
  const operational = complete && latest(metrics, "actorFreeListed") === "0" && latest(metrics, "down_restoredSqrt") === latest(metrics, "originalSqrt") && latest(metrics, "up_restoredSqrt") === latest(metrics, "originalSqrt") && latest(metrics, "down_helperResidue0") === "0" && latest(metrics, "down_helperResidue1") === "0" && latest(metrics, "up_helperResidue0") === "0" && latest(metrics, "up_helperResidue1") === "0";
  return { schema: "gamma-hypervisor-ordinary-spot-manipulation-fork/r1", capturedAt: new Date().toISOString(), pin, authorization: { keylessLocalFork: true, actorLocallyDealtOnlyLqtyAndWeth: true, actorStartsWithZeroGammaShares: true, privilegedPrankOrFunding: false, productionMutation: false, liveCall: false, signing: false, broadcast: false }, relay: { localhostOnlyForForge: true, cleanedUp: true, candidateFamiliesTested: tested, capableFamilies: capableCount, selectedFamilies: 1, methodCounts: counts, upstreamMaterialPersisted: false }, test: { harness: "harnesses/gamma-hypervisor-ordinary-spot-manipulation-r1/test/GammaOrdinarySpotManipulationR1.t.sol", contract: TEST, exitCode: run.exitCode, killed: run.killed, repeatedRuns: 2, metrics, outputSha256: run.outputSha256, complete, operational }, economics: econ, gates: { sourceAndReachabilityInheritedFromPriorFinalizedGates: true, ordinaryActor: latest(metrics, "actorFreeListed") === "0", realUniProxyAndPoolCallback: complete, boundaryDifferentialComplete: complete, restoreAndWithdrawComplete: operational, sameCapitalBaselineComplete: complete, routePositive: null, executableNow: false }, classification: complete ? "PENDING_REPEAT_STABILITY" : "INCOMPLETE_ROUTE_UNKNOWN", blockers: complete ? [] : ["Fork test did not produce every required branch metric."], budget: { rpcCalls: budget.calls, responseBytes: budget.bytes, limits: CAPS } };
}
function markdown(report) {
  const rows = report.economics.rows;
  return `# Gamma ordinary spot-manipulation fork R1

Date: ${report.capturedAt.slice(0, 10)}  
Historical pin: block \`${report.pin.number}\`, hash \`${report.pin.hash}\`  
Disposition: **${report.gates.routePositive === false ? "ROUTE NEGATIVE" : "ROUTE UNKNOWN"}**

## Safety and scope

Forge connected only to an ephemeral parent-held localhost read-only relay pinned to the historical block above. Upstream inventory material remained process-only. The ordinary actor was locally dealt only LQTY and WETH, started with zero Gamma shares, and was not free-listed. No owner, UniProxy owner, privileged role, or known free-listed account was impersonated or funded. No key, signing, broadcast, upstream transaction, production mutation, or live exploit call was used.

## Differential

The harness used the deployed UniProxy, Hypervisor, ClearingV2, and Uniswap V3 pool with a real swap callback. It ran a proportional maximum-cap baseline and both spot directions. Each manipulation binary-searched the last TWAP-passing and first-reverting exact-input amounts using snapshots, deposited at the ordinary 1-bp ratio endpoint, restored the original sqrt price, swept callback residue, and withdrew all actor shares.

| Branch | Last pass raw | First revert raw | Actor LQTY delta vs baseline | Actor WETH delta vs baseline | Conservative net wei | Net USD 1e18 | Net bps |
|---|---:|---:|---:|---:|---:|---:|---:|
${rows.map((row) => `| ${row.branch} | ${report.test.metrics[`${row.branch}_boundaryPass`]?.slice(-1)[0]} | ${report.test.metrics[`${row.branch}_boundaryFail`]?.slice(-1)[0]} | ${row.actorDeltaVsBaseline.lqtyRaw} | ${row.actorDeltaVsBaseline.wethWei} | ${row.conservativeNet.nativeWei} | ${row.conservativeNet.usdWad ?? "unknown"} | ${row.conservativeNet.bpsAttackerCapitalDecimal ?? "unknown"} |`).join("\n")}

## Accounting and gates

- Realized pool slippage and swap fees are included in actor final balances.
- Token0 residuals/liabilities use a 100-bp adverse valuation around pinned spot.
- Obligations include 5 bps one-day financing and full route gas at pinned base fee; no competition or latency upside is credited.
- Fee-recipient, pool protocol-fee, pool-balance, callback-residue, and incumbent-NAV deltas are retained in JSON.
- Repeated metrics stable: **${report.test.repeatedMetricsStable}**.
- \`routePositive\`: **${String(report.gates.routePositive)}**.
- \`executableNow\`: **false**.

Artifacts: \`reports/gamma-hypervisor-ordinary-spot-manipulation-fork-r1.json\` and sanitized raw capture/manifest under \`reports/raw/fast/gamma-hypervisor-ordinary-spot-manipulation-fork-r1/\`.
`;
}
async function main() {
  const inventory = fs.readFileSync(INVENTORY, "utf8"), candidates = parseInventory(inventory), secrets = secretCorpus(candidates), budget = new Budget(), qualification = await qualify(candidates, budget);
  if (!qualification.selected) throw new Error("no exact-pin archive-capable Ethereum family");
  const ethUsd = await oraclePrice(qualification.selected.ep, budget), relay = await startRelay(qualification.selected.ep, budget, qualification.selected.pin); let first, second;
  try { first = await runForge(relay.port); second = await runForge(relay.port); } finally { await new Promise((resolve) => relay.server.close(resolve)); }
  if (first.exitCode !== 0 || second.exitCode !== 0) process.stderr.write(`${[...first.summary, ...second.summary].join("\n").replace(/https?:\/\/\S+/giu, "[localhost-redacted]")}\n`);
  const stable = first.exitCode === 0 && second.exitCode === 0 && JSON.stringify(first.metrics) === JSON.stringify(second.metrics), selected = stable ? second : first;
  const report = buildReport(selected, qualification.selected.pin, qualification.tested, qualification.capable.length, relay.counts, budget, ethUsd); report.test.repeatedMetricsStable = stable;
  const allNegative = report.economics.rows.length === 2 && report.economics.rows.every((row) => BigInt(row.conservativeNet.nativeWei) < 0n);
  report.gates.routePositive = report.test.complete && report.test.operational && stable && allNegative ? false : null;
  report.classification = report.gates.routePositive === false ? "BOUNDED_ORDINARY_ROUTE_NEGATIVE" : "INCOMPLETE_ROUTE_UNKNOWN";
  if (!stable) report.blockers.push("Repeated fork metrics were not identical.");
  if (!allNegative) report.blockers.push("Both bounded direction branches were not strictly negative after obligations.");
  const raw = { schema: "gamma-hypervisor-ordinary-spot-manipulation-fork-raw/r1", pin: qualification.selected.pin, relay: { localhostOnly: true, cleanedUp: true, methodCounts: relay.counts }, runs: [first, second].map((run) => ({ exitCode: run.exitCode, killed: run.killed, metrics: run.metrics, outputSha256: run.outputSha256 })), repeatedMetricsStable: stable };
  guard(report, secrets); guard(raw, secrets); fs.mkdirSync(RAW, { recursive: true }); fs.writeFileSync(JSON_OUT, `${JSON.stringify(report, null, 2)}\n`); fs.writeFileSync(MD_OUT, markdown(report)); fs.writeFileSync(path.join(RAW, "capture-r1.json"), `${JSON.stringify(raw, null, 2)}\n`);
  const files = [JSON_OUT, MD_OUT, path.join(RAW, "capture-r1.json")].map((file) => ({ path: path.relative(ROOT, file).replace(/\\/gu, "/"), bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) }));
  const manifest = { schema: "gamma-hypervisor-ordinary-spot-manipulation-fork-manifest/r1", pin: qualification.selected.pin, files, repeatedMetricsStable: stable, gates: report.gates, secretGuardPassed: true, jsonValidated: true };
  guard(manifest, secrets); fs.writeFileSync(path.join(RAW, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`); JSON.parse(fs.readFileSync(JSON_OUT)); JSON.parse(fs.readFileSync(path.join(RAW, "capture-r1.json"))); JSON.parse(fs.readFileSync(path.join(RAW, "manifest.json")));
  process.stdout.write(`gamma ordinary fork complete: stable=${stable} routePositive=${String(report.gates.routePositive)} executableNow=false\n`);
}
main().catch((error) => { process.stderr.write(`gamma ordinary fork failed: ${String(error.message || error).replace(/https?:\/\/\S+/giu, "[redacted]")}\n`); process.exitCode = 1; });
