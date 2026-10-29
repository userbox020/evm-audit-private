#!/usr/bin/env node
"use strict";

// Bounded, read-only retry of the two previously incomplete Arbitrum rows.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const producer = require("./aave-v3-borrower-watch.js");
const root = path.resolve(__dirname, "..");
const seedPath = path.join(root, "bounded-research/2026-10-17-aave-v3-borrower-seed/seed-arbitrum.json");
const endpoint = `https://${"arbitrum-one"}.${"publicnode.com"}/`;
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const sanitize = (text) => text.replace(/(?:https?|wss?):\/\/[^\s"<>]+/gi, "[REDACTED_ENDPOINT]").replace(/(?:authorization\s*:|bearer\s+)[^\r\n"]*/gi, "[REDACTED_AUTH]").replace(/[?&](?:key|token)=[^\s"]*/gi, "[REDACTED_CREDENTIAL]");
const summary = (r) => Object.fromEntries(["chain", "chainId", "market", "user", "status", "reason", "hfWad", "hf", "verdict", "debtRaw", "debtBase", "noDebt"].map((k) => [k, r[k] ?? null]));
function atomic(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  assert.equal(sanitize(bytes.toString()), bytes.toString());
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
  try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
async function main() {
  const started = Date.now(), seed = JSON.parse(fs.readFileSync(seedPath));
  const prior = producer.readPrevious("live");
  assert.ok(prior && prior.borrowers.length === 27 && prior.crossSectionSummary.completeCount === 25);
  const watchList = producer.validateList(seed.borrower_market_pairs.map((r) => ({ chainId: seed.chain_id, market: r.market_address, user: r.borrower })));
  assert.deepEqual(watchList.map((r) => r.user).sort(), ["0x8e987c1a710683c8582401f21587932d7de2d45d", "0xb143f6ca55358fac056eca7ac1a228a1f018b048"]);
  assert.ok(watchList.every((r) => r.chainId === 42161 && prior.borrowers.some((p) => p.chainId === r.chainId && p.user === r.user && p.market === r.market && p.status === "INCOMPLETE")));
  const originalFetch = globalThis.fetch, failures = [];
  let requests = 0, stopped = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), endpoint);
    assert.ok(!stopped && ++requests <= 25 && Date.now() - started < 120000);
    const request = JSON.parse(options.body);
    assert.ok(["eth_chainId", "eth_getBlockByNumber", "eth_call"].includes(request.method));
    try {
      const response = await originalFetch(url, options);
      const text = await response.clone().text();
      let body; try { body = JSON.parse(text); } catch (_) { /* captured below */ }
      if (!response.ok || !body || body.error || body.jsonrpc !== "2.0" || body.id !== request.id || !Object.hasOwn(body, "result")) {
        stopped = true;
        failures.push({ method: request.method, httpStatus: response.status, responseBody: sanitize(text) });
      }
      if (request.method === "eth_chainId" && body?.result !== "0xa4b1") {
        stopped = true;
        throw new Error("CHAIN_MISMATCH");
      }
      return response;
    } catch (error) {
      stopped = true;
      failures.push({ method: request.method, message: sanitize(String(error.message)) });
      throw new Error(error.message === "CHAIN_MISMATCH" ? "CHAIN_MISMATCH" : "RPC_FAILURE");
    }
  };
  let retry;
  try { retry = await producer.capture({ watchList, mode: "live", rpcUrl: endpoint }); }
  finally { globalThis.fetch = originalFetch; }
  retry.provenance.retryOf = { artifact: prior.artifactPath, sha256: prior.artifactSha256 };
  retry.provenance.provider = "PublicNode Arbitrum; explicit keyless endpoint redacted";
  retry.diagnostics.providerFailures = failures;
  retry.diagnostics.maxRequests = 25;
  assert.equal(retry.diagnostics.networkRequestCount, requests);
  const retryArtifact = producer.persist(retry);
  const retrySha = sha(fs.readFileSync(path.join(root, retryArtifact)));

  // Preserve the original Ethereum observations and explicitly label this as
  // a composite evidence update, not a fresh 27-user simultaneous capture.
  const merged = structuredClone(prior);
  for (const key of ["artifactPath", "artifactSha256", "freshness"]) delete merged[key];
  merged.generatedAt = retry.generatedAt;
  merged.runId = crypto.randomBytes(8).toString("hex");
  merged.borrowers = prior.borrowers.map((r) => retry.borrowers.find((n) => n.chainId === r.chainId && n.market === r.market && n.user === r.user) ?? r);
  merged.pins[42161] = retry.pins[42161];
  merged.status = merged.borrowers.every((r) => r.status === "COMPLETE") ? "COMPLETE" : "INCOMPLETE";
  merged.reason = merged.status === "COMPLETE" ? null : "PARTIAL_READ";
  merged.provenance.explicitRpcChainId = null;
  merged.provenance.composition = { method: "Preserved 25 Ethereum rows from prior capture; replaced only two Arbitrum rows from bounded retry. Independent per-chain finalized pins, not a simultaneous refresh.", sources: [{ artifact: prior.artifactPath, sha256: prior.artifactSha256 }, { artifact: retryArtifact, sha256: retrySha }] };
  const ranked = merged.borrowers.filter((r) => r.status === "COMPLETE").sort((a, b) => BigInt(a.hfWad) < BigInt(b.hfWad) ? -1 : BigInt(a.hfWad) > BigInt(b.hfWad) ? 1 : a.user.localeCompare(b.user));
  merged.rankedBorrowerSummary = [...ranked, ...merged.borrowers.filter((r) => r.status !== "COMPLETE")].map(summary);
  const closest = ranked.find((r) => !r.noDebt);
  merged.closestToLiquidation = closest ? { ...summary(closest), partialCrossSection: merged.status !== "COMPLETE", scope: "selected complete non-zero-debt borrowers only" } : null;
  merged.crossSectionSummary = { count: 27, completeCount: ranked.length, incompleteCount: 27 - ranked.length, partial: ranked.length !== 27,
    verdictCounts: Object.fromEntries(["LIQUIDATABLE", "NEAR_LIQUIDATION", "ABOVE_WATCH_THRESHOLD", "HEALTHY", "INCOMPLETE"].map((v) => [v, merged.borrowers.filter((r) => r.verdict === v).length])),
    nonZeroObservationsForReview: merged.borrowers.filter((r) => r.status === "COMPLETE" && !r.noDebt && ["LIQUIDATABLE", "NEAR_LIQUIDATION"].includes(r.verdict)).map(summary) };
  merged.diagnostics.ledger = [...prior.diagnostics.ledger, ...retry.diagnostics.ledger].map((entry, index) => ({ ...entry, ordinal: index + 1 }));
  merged.diagnostics.rpcCount = prior.diagnostics.rpcCount + requests;
  merged.diagnostics.networkRequestCount = prior.diagnostics.networkRequestCount + requests;
  merged.diagnostics.providerFailures = failures;
  for (const [user, count] of Object.entries(retry.diagnostics.perUserGetterCounts)) merged.diagnostics.perUserGetterCounts[user] = (merged.diagnostics.perUserGetterCounts[user] ?? 0) + count;
  merged.timing = { ...retry.timing, durationMs: prior.timing.durationMs + retry.timing.durationMs, composition: "Sum of source capture durations; not a single capture window" };
  const combinedArtifact = producer.persist(merged, true);

  seed.health_factor_queried = true;
  seed.health_factor_capture = { status: retry.status, artifact: retryArtifact, sha256: retrySha, pin: retry.pins[42161] ?? null,
    chain_id_verified_hex: retry.provenance.explicitRpcChainId === 42161 ? "0xa4b1" : null, rpc_count: requests, rows: retry.borrowers.map(summary), provider_failures: failures,
    note: "HF-only refresh; the original event/reserve scan pin is unchanged." };
  atomic(seedPath, seed);
  const latest = producer.readPrevious("live");
  assert.ok(latest && latest.artifactPath === combinedArtifact && latest.crossSectionSummary.completeCount === ranked.length);
  assert.ok(Date.now() - started < 120000);
  console.log(JSON.stringify({ retryArtifact, combinedArtifact, seedUpdated: path.relative(root, seedPath), pin: retry.pins[42161] ?? null,
    chainIdVerified: retry.provenance.explicitRpcChainId === 42161, rows: retry.borrowers.map(summary), rpcCount: requests, durationMs: Date.now() - started,
    providerFailures: failures, combinedSummary: merged.crossSectionSummary, sanitization: "PASS: no endpoint, keys or auth material in artifacts", manifestAndLatestVerification: "PASS" }, null, 2));
}
main().catch((error) => { console.log(JSON.stringify({ status: "INCOMPLETE", error: sanitize(error.message) })); process.exitCode = 1; });
