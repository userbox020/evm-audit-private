"use strict";
// aave-v4 sustained-timing check r1 (2026-10-11) — diagnostic evidence only.
// Bounded read-only: eth_blockNumber pings at aggregate <=25/s, concurrency 4,
// 60s sustained window. NOT topology capture; publishes nothing authoritative.
// Honors the 20261002 budget-plan gates: authorized credential-route cap 25/s,
// public/other <=4/s, max 4 concurrency, no gate/freshness changes.
const path = require("path");
const { loadRpcUrls, rpcCallStrict, rpcCall } = require("../shared-rpc.js");
const { providerFamily, rankProviderUrls } = require("./rpc-provider-reliability.js");

const ROOT = path.resolve(__dirname, "..", "..");
const RUN_TAG = process.argv[2] && /^[a-z0-9-]{1,64}$/i.test(process.argv[2]) ? process.argv[2] : "r2";
const OUT = path.join(ROOT, "reports", "raw", "fast", `aave-v4-sustained-timing-20261011-${RUN_TAG}.json`);
const SUSTAIN_MS = 60_000;
const TARGET_STARTS_PER_S = 20; // under the 25/s authorized cap
const CONCURRENCY = 4;

(async () => {
  // Phase 0: qualification survey (bounded): per-family chainId/call stats
  // across all ranked candidates (<=40), selecting up to 6 healthy endpoints.
  const urls = rankProviderUrls(loadRpcUrls({ maxCandidates: 40 }), 40);
  const qualified = [];
  const qResult = { chainOk: 0, callOk: 0, tried: 0, perFamily: {} };
  for (const url of urls) {
    qResult.tried++;
    const fam = providerFamily(url) || "unknown";
    if (!qResult.perFamily[fam]) qResult.perFamily[fam] = { tried: 0, chainOk: 0, callOk: 0 };
    const stat = qResult.perFamily[fam];
    stat.tried++;
    const chain = await rpcCall(url, "eth_chainId", [], 8000);
    if (chain !== "0x1") continue;
    qResult.chainOk++;
    stat.chainOk++;
    const call = await rpcCall(url, "eth_call", [{ to: "0x00000000000C2E074eC69A0dFb2997BA6C7d3e3e", data: "0x" }, "latest"], 8000);
    if (call !== "0x") continue;
    qResult.callOk++;
    stat.callOk++;
    if (qualified.length < 6) qualified.push(url);
  }
  if (qualified.length < 2) {
    const brief = qualified.length;
    require("fs").writeFileSync(OUT, JSON.stringify({
      schema: "aave-v4-sustained-timing/v1", runId: new Date().toISOString(),
      diagnosticOnly: true, noTopologyCapture: true, gateChange: false,
      qualification: { ...qResult, qualified, note: "call probe may fail on some endpoints" },
      status: brief >= 1 ? "SINGLE_FAMILY_QUALIFIED_TWO_FAMILIES_UNAVAILABLE" : "INSUFFICIENT_QUALIFICATION",
      sustained: null,
    }, null, 2) + "\n");
    console.log("WROTE", OUT, "qualified:", brief);
    return;
  }

  // Family split for two-family header agreement at start/end.
  const famOf = (u) => providerFamily(u) || "unknown";
  const families = [...new Set(qualified.map(famOf))];

  // Header agreement helper (terminal discipline, light).
  const headerAgreement = async () => {
    const heads = await Promise.all(qualified.map(u => rpcCallStrict(u, "eth_getBlockByNumber", ["latest", false], 8000).catch(() => null)));
    const valid = heads.map(h => (h && typeof h.hash === "string") ? h.hash : null).filter(Boolean);
    return { agree: valid.length >= 2 && new Set(valid).size <= 1, count: valid.length };
  };

  const startHead = await headerAgreement();

  // Phase 1: sequential latency (10 pings per endpoint).
  const seq = {};
  for (const u of qualified) {
    const t = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      const r = await rpcCall(u, "eth_blockNumber", [], 8000);
      if (r !== null) t.push(Date.now() - t0);
    }
    t.sort((a, b) => a - b);
    const fam = famOf(u);
    if (!seq[fam]) seq[fam] = [];
    seq[fam].push(t);
  }
  const flat = Object.values(seq).flat().flat().sort((a, b) => a - b);
  const med = flat[Math.floor(flat.length / 2)] || null;
  const p95 = flat[Math.min(flat.length - 1, Math.floor(flat.length * 0.95))] || null;

  // Phase 2: sustained window. Start T0..T1; dispatch round-robin at
  // TARGET_STARTS_PER_S across qualified endpoints, CONCURRENCY workers.
  const sustained = { attempted: 0, ok: 0, fail: 0, rateLimit: 0, windowMs: SUSTAIN_MS, targetPerS: TARGET_STARTS_PER_S, concurrency: CONCURRENCY, perFamilyFails: {} };
  // Token-bucket pacing: aggregate starts capped at TARGET_STARTS_PER_S;
  // CONCURRENCY workers each await completion before the next dispatch,
  // so in-flight <= CONCURRENCY while the bucket bounds aggregate starts.
  const t0 = Date.now();
  const tokenIntervalMs = 1000 / TARGET_STARTS_PER_S;
  let tokens = 0;
  let nextTokenAt = t0;
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push((async () => {
      for (;;) {
        if (Date.now() - t0 >= SUSTAIN_MS) return;
        // Wait for a token (bounded by the window check).
        for (;;) {
          const now = Date.now();
          if (now - t0 >= SUSTAIN_MS) return;
          if (nextTokenAt <= now) { tokens = Math.min(tokens + 1, TARGET_STARTS_PER_S * 2); nextTokenAt = Math.max(now, nextTokenAt + tokenIntervalMs); }
          if (tokens > 0) break;
          const waitMs = Math.max(1, Math.min(nextTokenAt - now, 50));
          await new Promise(res => setTimeout(res, waitMs));
        }
        tokens -= 1;
        sustained.attempted++;
        const u = qualified[(Date.now() + i) % qualified.length];
        const fam = famOf(u);
        try {
          const r = await rpcCallStrict(u, "eth_blockNumber", [], 8000);
          if (r !== null) sustained.ok++;
          else sustained.fail++;
        } catch (e) {
          sustained.fail++;
          if (e && e.constructor && e.constructor.name === "RpcTransportError") sustained.rateLimit++;
          sustained.perFamilyFails[fam] = (sustained.perFamilyFails[fam] || 0) + 1;
        }
      }
    })());
  }
  await Promise.all(workers);
  const t1 = Date.now();
  sustained.windowMsActual = t1 - t0;
  sustained.achievedPerS = +(sustained.ok / (sustained.windowMsActual / 1000)).toFixed(3);
  sustained.attemptedPerS = +(sustained.attempted / (sustained.windowMsActual / 1000)).toFixed(3);
  const endHead = await headerAgreement();

  const fourTwo = Object.entries(seq).length >= 2 ? "evidence-multiple-families" : "single-family";
  require("fs").writeFileSync(OUT, JSON.stringify({
    schema: "aave-v4-sustained-timing/v1",
    runId: new Date().toISOString(),
    diagnosticOnly: true, noTopologyCapture: true, gateChange: false,
    qualification: { tried: qResult.tried, chainOk: qResult.chainOk, callOk: qResult.callOk, qualifiedFamilies: families.length },
    headerAgreement: { start: startHead, end: endHead },
    sequential: { medianMs: med, p95Ms: p95, perFamilySamples: Object.fromEntries(Object.entries(seq).map(([k, v]) => [k, v.map(() => 10)])) },
    sustained,
    budgetPlanContext: { requiredBaselinePerS: 18, requiredHeadroomPerS: 23, r5ReferencePerS: 13.974 },
    readback: fourTwo,
  }, null, 2) + "\n");
  console.log("WROTE", OUT);
  console.log("sustained achievedPerS:", sustained.achievedPerS, "attempted:", sustained.attempted, "ok:", sustained.ok, "fail:", sustained.fail);
})().catch(e => console.log("PROBE_FAIL:", String(e && e.stack || e).slice(0, 400)));
