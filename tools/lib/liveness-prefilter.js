"use strict";
/*
 * tools/lib/liveness-prefilter.js
 *
 * Read-only liveness prefilter for class-matched ERC-4626 rows. Suppresses
 * dormant / uninitialized identical-code clusters BEFORE human triage by
 * probing `asset()`, `totalAssets()`, and `totalSupply()` with `eth_call`.
 *
 * Conservative by design:
 *   - Only positively-established dormancy/uninitialization suppresses a row.
 *   - Any call error (revert, timeout, malformed result) is kept as
 *     "indeterminate" and the row survives to triage.
 *   - Never signs, never mutates state, never emits endpoint values.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const SELECTORS = Object.freeze({
  asset: "0x38d52e0f", // asset()
  totalAssets: "0x01e1d114", // totalAssets()
  totalSupply: "0x18160ddd", // totalSupply()
});

const DEFAULTS = Object.freeze({ concurrency: 4, callGas: null });

function sanitizeReason(e) {
  const raw = e && e.message ? e.message : String(e);
  return raw
    .replace(/https?:\/\/[^\s"')]+/g, "<endpoint>")
    .replace(/[\w.-]+\.(com|org|io|net|xyz|dev)\b/g, "<host>")
    .slice(0, 120);
}

function decodeUint(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) return { ok: false, reason: "malformed" };
  const body = hex.slice(2);
  if (body.length === 0) return { ok: false, reason: "empty-result" };
  if (body.length < 64) return { ok: false, reason: "short-result" };
  try {
    return { ok: true, value: BigInt("0x" + body.slice(0, 64)) };
  } catch {
    return { ok: false, reason: "decode-failed" };
  }
}

function decodeAddress(hex) {
  const u = decodeUint(hex);
  if (!u.ok) return u;
  const word = u.value.toString(16).padStart(64, "0");
  return { ok: true, value: "0x" + word.slice(24) };
}

async function callSelector(rpcCall, address, selector) {
  try {
    const res = await rpcCall("eth_call", [{ to: address, data: selector }, "latest"]);
    return { ok: true, result: res && res.result };
  } catch (e) {
    return { ok: false, reason: sanitizeReason(e) };
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    new Array(n).fill(0).map(async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        try {
          results[i] = { ok: true, value: await worker(items[i], i) };
        } catch (e) {
          results[i] = { ok: false, error: sanitizeReason(e) };
        }
      }
    })
  );
  return results;
}

/**
 * Decide liveness for one ERC-4626 row from its three probe results.
 * Exported for offline unit testing.
 */
function decideLiveness(probe) {
  const asset = probe.asset;
  const totalAssets = probe.totalAssets;
  const totalSupply = probe.totalSupply;

  const assetZero = asset.ok && asset.value === ZERO_ADDRESS;
  const taOk = totalAssets.ok;
  const tsOk = totalSupply.ok;
  const taZero = taOk && totalAssets.value === 0n;
  const tsZero = tsOk && totalSupply.value === 0n;

  if (assetZero) return { liveness: "dormant", reasons: ["asset-zero-address"] };
  if (taOk && taZero && tsOk && tsZero) return { liveness: "dormant", reasons: ["zero-totalAssets-and-totalSupply"] };
  if (!asset.ok && !taOk) return { liveness: "dormant", reasons: ["asset-and-totalAssets-revert"] };

  if ((taOk && totalAssets.value > 0n) || (tsOk && totalSupply.value > 0n) || (asset.ok && asset.value !== ZERO_ADDRESS && taOk && totalAssets.value > 0n)) {
    return { liveness: "live", reasons: [] };
  }

  const reasons = [];
  if (!asset.ok) reasons.push("asset:" + (asset.reason || "error"));
  if (!taOk) reasons.push("totalAssets:" + (totalAssets.reason || "error"));
  if (!tsOk) reasons.push("totalSupply:" + (totalSupply.reason || "error"));
  if (taOk && taZero) reasons.push("totalAssets-zero");
  if (tsOk && tsZero) reasons.push("totalSupply-zero");
  return { liveness: "indeterminate", reasons };
}

/**
 * @param {(method:string, params:any[])=>Promise<{result:any}>} rpcCall
 * @param {Array<object>} rows classified row objects (mutated with `.liveness`)
 * @returns {Promise<{stats:object}>}
 */
async function livenessPrefilter(rpcCall, rows, opts = {}) {
  const concurrency = Number.isFinite(opts.concurrency) ? opts.concurrency : DEFAULTS.concurrency;
  const targets = rows.filter((r) => r && r.riskClass === "vault-erc4626" && r.class === "vault-erc4626");

  const stats = {
    class: "vault-erc4626",
    evaluated: targets.length,
    live: 0,
    dormant: 0,
    indeterminate: 0,
    removed: 0,
    kept: 0,
    byReason: {},
    callErrors: 0,
  };

  await mapLimit(targets, concurrency, async (row) => {
    const [a, t, s] = await Promise.all([
      callSelector(rpcCall, row.address, SELECTORS.asset),
      callSelector(rpcCall, row.address, SELECTORS.totalAssets),
      callSelector(rpcCall, row.address, SELECTORS.totalSupply),
    ]);
    const probe = {
      asset: a.ok ? decodeAddress(a.result) : { ok: false, reason: a.reason },
      totalAssets: t.ok ? decodeUint(t.result) : { ok: false, reason: t.reason },
      totalSupply: s.ok ? decodeUint(s.result) : { ok: false, reason: s.reason },
    };
    if (!probe.asset.ok) stats.callErrors++;
    if (!probe.totalAssets.ok) stats.callErrors++;
    if (!probe.totalSupply.ok) stats.callErrors++;

    const decision = decideLiveness(probe);
    row.liveness = decision.liveness;
    row.livenessReasons = decision.reasons;
    row.livenessProbe = {
      asset: probe.asset.ok ? probe.asset.value : null,
      totalAssets: probe.totalAssets.ok ? probe.totalAssets.value.toString() : null,
      totalSupply: probe.totalSupply.ok ? probe.totalSupply.value.toString() : null,
      errors: decision.liveness === "live" ? [] : decision.reasons,
    };

    if (decision.liveness === "live") stats.live++;
    else if (decision.liveness === "dormant") {
      stats.dormant++;
      stats.removed++;
      for (const r of decision.reasons) stats.byReason[r] = (stats.byReason[r] || 0) + 1;
    } else {
      stats.indeterminate++;
      stats.kept++;
    }
  });

  stats.kept = stats.live + stats.indeterminate;
  return { stats };
}

module.exports = { livenessPrefilter, decideLiveness, SELECTORS, _internal: { decodeUint, decodeAddress, sanitizeReason } };
