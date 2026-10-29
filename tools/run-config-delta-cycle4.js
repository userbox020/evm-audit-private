#!/usr/bin/env node
"use strict";
/**
 * run-config-delta-cycle4.js
 *
 * Cycle-4 independent-sample driver for the config-delta saturation test.
 *
 * Cycle 4 exists to close the recorded caveat that cycles 2 and 3 were not
 * independent temporal samples: its window must NOT overlap the cycle-3
 * window on any chain. The reopen predicate is satisfied when, per chain,
 * head >= cycle3Top + cycle3Depth (Ethereum >= 26,010,225, Base >= 51,447,221,
 * Arbitrum >= 506,231,451). Because the scanner derives fromBlock from the
 * live tip, a satisfied predicate yields fromBlock(cycle4) > toBlock(cycle3).
 * This driver re-proves that non-overlap after the scan and refuses to label
 * the run independent if it fails.
 *
 *  1. capability-qualifies a bounded endpoint pool per chain (archive state +
 *     full-window deep eth_getLogs) via tools/qualify-config-delta-rpcs-v1.js;
 *  2. writes the sanitized cycle-4 qualification artifact;
 *  3. spawns tools/scan-config-deltas.js with the selected endpoints supplied
 *     process-only via the child ENVIRONMENT (never argv), in strict-endpoint
 *     mode, writing reports/raw/fast/config-deltas-cycle4-20260920.json;
 *  4. reads cycle-3 + cycle-4 artifacts and reports per-chain window
 *     independence (numbers only; no endpoint material).
 *
 * No endpoint value/URL/host/credential is printed, logged, persisted or placed
 * on a child command line. Only capability outcomes and counts are emitted.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { qualify } = require("./qualify-config-delta-rpcs-v1.js");

const WORKSPACE = path.resolve(__dirname, "..");
const OUT_DIR = path.join(WORKSPACE, "reports", "raw", "fast");
const CHAIN_IDS = [1, 8453, 42161, 56];
const CYCLE4_OUT = "config-deltas-cycle4-20260920.json";
const CYCLE3_OUT = "config-deltas-cycle3-20260915.json";
const QUAL_FILE = path.join(OUT_DIR, "config-delta-cycle4-rpc-qualification.json");

const CYCLE3_TOPS = { 1: 25985225, 8453: 51357221, 42161: 505531451, 56: 122093002 };

function independence() {
  try {
    const c4 = JSON.parse(fs.readFileSync(path.join(OUT_DIR, CYCLE4_OUT), "utf8"));
    const c3 = JSON.parse(fs.readFileSync(path.join(OUT_DIR, CYCLE3_OUT), "utf8"));
    const perChain = {};
    for (const [cid, row] of Object.entries(c4.chains)) {
      const c3top = CYCLE3_TOPS[cid] ?? c3.chains[cid]?.toBlock ?? null;
      perChain[cid] = {
        cycle3Top: c3top,
        cycle4From: row.fromBlock,
        cycle4To: row.toBlock,
        gapAboveCycle3Top: c3top === null ? null : row.fromBlock - c3top,
        nonOverlapping: c3top === null ? null : row.fromBlock > c3top,
      };
    }
    return { perChain, allNonOverlapping: Object.values(perChain).every((r) => r.nonOverlapping !== false) };
  } catch (_) {
    return { perChain: null, allNonOverlapping: null };
  }
}

async function main() {
  const { urlMap, artifact, selection } = await qualify({ chainIds: CHAIN_IDS });
  artifact.generatedFor = "config-delta-axis-cycle4-20260920";

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(QUAL_FILE, JSON.stringify(artifact, null, 2) + "\n", "utf8");

  const qualifiedChains = CHAIN_IDS.filter((cid) => artifact.perChain[cid] && artifact.perChain[cid].capability);
  const unavailableChains = CHAIN_IDS.filter((cid) => !qualifiedChains.includes(cid));

  console.log("qualification=" + JSON.stringify({
    qualifiedChains,
    unavailableChains,
    perChain: Object.fromEntries(CHAIN_IDS.map((cid) => [cid, {
      capability: artifact.perChain[cid]?.capability || false,
      archiveReadyCount: artifact.perChain[cid]?.archiveReadyCount ?? null,
      logsReadyCount: artifact.perChain[cid]?.logsReadyCount ?? null,
      independentFamiliesSelected: artifact.perChain[cid]?.independentFamiliesSelected ?? 0,
    }])),
    selection,
  }));

  if (qualifiedChains.length === 0) {
    console.error("cycle4 aborted: no chain capability-qualified");
    process.exitCode = 1;
    return;
  }

  const env = {
    ...process.env,
    CONFIG_DELTA_RPC_JSON: JSON.stringify(urlMap),
    CONFIG_DELTA_STRICT_ENDPOINTS: "1",
    CONFIG_DELTA_OUT: CYCLE4_OUT,
    CONFIG_DELTA_PROFILE: "cycle4",
  };

  const child = spawn(process.execPath, ["tools/scan-config-deltas.js"], {
    cwd: WORKSPACE,
    env,
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    const indep = independence();
    console.log("independence=" + JSON.stringify(indep));
    if (indep.allNonOverlapping === false) console.error("cycle4 WARNING: window overlaps cycle 3 on at least one chain - NOT an independent sample");
    process.exitCode = code === 0 ? 0 : 1;
  });
  child.on("error", () => { console.error("cycle4 scanner spawn failed"); process.exitCode = 1; });
}

main().catch((error) => {
  console.error("run-config-delta-cycle4 failed: " + String(error && error.message ? error.message : "error").replace(/https?:\/\/\S+/g, "[redacted]"));
  process.exitCode = 1;
});
